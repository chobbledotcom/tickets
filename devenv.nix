{
  inputs,
  pkgs,
  lib,
  config,
  ...
}:

let
  # Pinned solely to provide Deno 2.5.6 — the lowest Bunny Edge Scripting
  # runtime this project supports and the version the suite is verified
  # against. Everything else comes from the main nixpkgs input, so only Deno
  # is held back; bump this rev when the supported floor moves.
  deno = (
    import inputs.nixpkgs-deno { system = pkgs.stdenv.hostPlatform.system; }
  ).deno;

  denoVersion = "2.5.6";

  # Same contract the flake-installed hook had: the full precommit gate on
  # every commit, identically from any shell. The hook script puts the
  # pinned tools first on PATH (writeShellApplication adds its runtime
  # inputs — the same tool set the dev shell exposes), so a stray
  # system-profile binary — for example a newer Biome, or a different
  # OpenSSL whose CMS signing behaves differently — can never answer
  # inside the gate. The libstdc++ path must ride along too: the
  # database FFI loads native libraries that resolve it outside a
  # shell, and a missing one crashes the test runner partway through
  # the suite.
  precommitHook = pkgs.writeShellApplication {
    name = "tickets-precommit-hook";
    runtimeInputs = [
      deno
      pkgs.biome
      pkgs.curl
      pkgs.git
      pkgs.jq
      pkgs.openssl
    ];
    text = ''
      ${lib.optionalString pkgs.stdenv.isLinux ''
        export LD_LIBRARY_PATH="${lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]}:''${LD_LIBRARY_PATH:-}"
      ''}
      exec ${deno}/bin/deno task precommit
    '';
  };

  # Server entrypoint for the OCI image. Grants the server the minimum
  # permission set it needs, and the same fill-if-unset DB default as the
  # shell: a caller's own value wins, even a deliberately empty one.
  serverStart = pkgs.writeShellApplication {
    name = "tickets-server";
    runtimeInputs = [
      deno
      pkgs.coreutils
      pkgs.util-linux
    ];
    text = ''
      set -euo pipefail
      if [ ! -d /deno-cache ]; then
        echo "This image was assembled without a Deno cache directory." >&2
        exit 1
      fi
      # Platforms start the image as root or as a chosen uid. When root, drop
      # to an unprivileged uid first: Deno and SQLite must write to the module
      # cache and /data as the user that serves. A freshly mounted volume is
      # root-owned, so prepare /data for that uid before the drop.
      if [ "$(id -u)" -eq 0 ]; then
        mkdir -p /data
        chown -R 1000:1000 /data 2>/dev/null || true
        exec setpriv --reuid=1000 --regid=1000 --clear-groups "$0" "$@"
      fi
      # The container's root filesystem is a writable union, so Deno writes
      # its analysis caches into the baked module cache directly.
      export DENO_DIR=/deno-cache
      export DB_URL="''${DB_URL-file:/data/tickets.db}"
      cd /app
      exec deno run \
        --allow-net \
        --allow-env \
        --allow-read \
        --allow-write=/data \
        --allow-sys \
        --allow-ffi \
        src/index.ts
    '';
  };

  # The app tree, read when the image is built, so it carries the built
  # static assets (esbuild + sass output under src/ui/static). The
  # e2e-payments workspace member config ships too: Deno refuses to load
  # deno.json without every declared workspace member present, and without
  # the config the "#..." import aliases in src cannot resolve.
  appTree = pkgs.runCommand "tickets-app" { } ''
    mkdir -p $out/app/e2e-payments
    cp -r ${./src} $out/app/src
    cp ${./deno.json} $out/app/deno.json
    cp ${./deno.lock} $out/app/deno.lock
    cp ${./e2e-payments/deno.json} $out/app/e2e-payments/deno.json
    chmod -R ugo+rX $out
  '';

  # The server's Deno module cache, produced by container-build before the
  # image is assembled (the Nix sandbox blocks the network the cache needs).
  # Kept as its own derivation so it layers separately from the app tree.
  denoCacheRoot = pkgs.runCommand "tickets-deno-cache" { } ''
    mkdir -p $out/deno-cache
    cp -r ${./.container-work/deno-cache}/. $out/deno-cache/
    chmod -R ugo+rX $out
  '';

  runtimeImage = pkgs.dockerTools.streamLayeredImage {
    name = "ghcr.io/chobbledotcom/tickets";
    tag = "latest";
    # One layer per tree: the store closure (Deno runtime), the source tree,
    # the server entrypoint, and the module cache.
    contents = [
      appTree
      serverStart
      denoCacheRoot
    ];
    # dockerTools merges `contents` with a per-file symlinkJoin: the merged
    # directories are real, but every file inside them is a symlink into
    # /nix/store. Deno's node-compat follows the realpaths, executes npm
    # modules from the store paths, and dies classifying them ("require is
    # not defined" inside libsql). Replace both trees with real files.
    fakeRootCommands = ''
      deref() {
        mv "./$1" "./$1.linked"
        cp -aL "./$1.linked" "./$1"
        rm -rf "./$1.linked"
      }
      deref app
      deref deno-cache
      mkdir -p ./tmp ./data
      chmod 1777 ./tmp
      # Nix strips write bits when registering store paths; the uid the
      # server drops to must be able to write the module cache and /data.
      chmod -R u+w ./app ./deno-cache
      chown -R 1000:1000 ./app ./deno-cache ./data
    '';
    config = {
      # The healthcheck execs Deno without the entrypoint's shell, so the
      # module cache location must reach it through the image environment.
      Env = [ "DENO_DIR=/deno-cache" ];
      Entrypoint = [ "${serverStart}/bin/tickets-server" ];
      WorkingDir = "/app";
      # Same HEALTHCHECK the deleted Dockerfile declared: localhost port
      # 3000, 30s apart, 5s budget, 10s grace, three strikes. The engine
      # execs the array without a shell, so Deno needs its absolute path;
      # `deno eval` runs with all permissions. /health answers before
      # setup is complete; / does not.
      Healthcheck = {
        Test = [
          "CMD"
          "${deno}/bin/deno"
          "eval"
          "const r = await fetch('http://127.0.0.1:3000/health'); if (!r.ok) Deno.exit(1);"
        ];
        Interval = 30000000000;
        Retries = 3;
        StartPeriod = 10000000000;
        Timeout = 5000000000;
      };
    };
  };
in
{
  # Browser-driven tasks (screenshot contracts, Cucumber Features,
  # payment e2e) need Chromium, the single largest item in the
  # environment. CI jobs that never launch a browser select the ci
  # profile (devenv --profile ci shell) and skip that download;
  # developers and the browser-driven workflows get the full default.
  options.ticketsBrowserTools = lib.mkOption {
    type = lib.types.bool;
    default = true;
  };

  config = {
    profiles.ci.module.ticketsBrowserTools = false;

    languages.deno = {
      enable = true;
      package = deno;
    };

    packages =
      [
        pkgs.curl
        pkgs.jq
        pkgs.openssl
      ]
      ++ lib.optionals (!config.container.isBuilding) (
        [
          pkgs.biome
          pkgs.gh
          pkgs.git
        ]
        ++ lib.optionals (config.ticketsBrowserTools && pkgs.stdenv.isLinux)
          [ pkgs.chromium ]
      );

  # The self-host image: `container-build` assembles it (running the Deno
  # steps first), `container-load` streams it into Docker/Podman.
  scripts = {
    pc.exec = ''exec deno task precommit "$@"'';
    # Builds the static assets and the server's Deno module cache, then
    # assembles the OCI runtime image. The two Deno steps must happen in the
    # shell, not inside the Nix build sandbox: esbuild, sass, and the module
    # cache all resolve through the network, which the sandbox blocks. Both
    # artifacts are byte-deterministic from deno.lock.
    container-build.exec = ''
      set -euo pipefail
      deno install --allow-scripts
      deno task build:static
      mkdir -p .container-work
      DENO_DIR="$PWD/.container-work/deno-cache" deno cache src/index.ts
      # Some npm packages ship a biome.json whose extends breaks Biome's
      # project-wide config discovery (Biome aborts on any broken nested
      # biome.json), and the cache lives inside the project. Lint configs
      # are never read at runtime, so drop them from the cache.
      find .container-work/deno-cache -name biome.json -delete
      devenv build outputs.tickets-image
    '';
    # Streams the built image into the local Docker/Podman store as
    # ghcr.io/chobbledotcom/tickets:latest.
    container-load.exec = ''
      set -euo pipefail
      stream="$(devenv build outputs.tickets-image | jq -r '."outputs.tickets-image"')"
      loader="$(command -v podman || command -v docker)"
      "$stream" | "$loader" load
    '';
  };

  git-hooks.hooks.precommit = {
    enable = true;
    entry = "${precommitHook}/bin/tickets-precommit-hook";
    pass_filenames = false;
  };

  enterShell = ''
    deno_output="$(${deno}/bin/deno --version)"
    deno_line="''${deno_output%%$'\n'*}"
    if [[ "$deno_line" != "deno ${denoVersion} "* ]]; then
      echo "tickets requires Deno ${denoVersion}, but the pinned nixpkgs provides $deno_line" >&2
      return 1
    fi

    echo "tickets dev shell"
    echo "  deno task start      - run server"
    echo "  deno task test       - run tests"
    echo "  deno task build:edge - build for edge"
    echo "  deno task screenshot - capture representative pages"
    echo "  deno task precommit  - typecheck + lint + cpd + build + test"
    echo "  pc                   - run precommit"
    echo "  container-build      - assemble the OCI runtime image"
    echo "  container-load       - load the image into Docker/Podman"
    # The deno module caches under .devenv/state, inside the project. Biome
    # discovers nested biome.json files project-wide and hard-fails on the
    # broken extends that npm packages (for example @cucumber/gherkin) ship,
    # so keep the module cache outside the tree, where Deno puts it by
    # default.
    export DENO_DIR="$HOME/.cache/deno"
    # Throwaway defaults for a fresh checkout. ''${VAR-...} fills in only
    # an unset variable, so the caller's own value wins — even a
    # deliberately empty one, which must fail startup validation.
    # The dev database is a gitignored file, so its encryption key must
    # survive the shell too: generate once into .db-key, reuse after.
    [ -f .db-key ] || openssl rand -base64 32 > .db-key
    export DB_ENCRYPTION_KEY="''${DB_ENCRYPTION_KEY-$(cat .db-key)}"
    export DB_URL="''${DB_URL-file:./local.db}"
    export PORT="''${PORT-8080}"
    # libstdc++ for the native libraries the database FFI loads — needed
    # in every Linux shell, also the ci profile, and also outside the
    # dev shell (the precommit hook exports the same path).
    ${lib.optionalString pkgs.stdenv.isLinux ''
      export LD_LIBRARY_PATH="${
        lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]
      }:''${LD_LIBRARY_PATH:-}"
    ''}
    ${lib.optionalString (config.ticketsBrowserTools && pkgs.stdenv.isLinux) ''
      export CHROMIUM_EXECUTABLE="${pkgs.chromium}/bin/chromium"
    ''}
  '';

  outputs.tickets-image = runtimeImage;
  };
}
