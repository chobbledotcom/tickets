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

  # Shared by the pre-commit hook and the dev shell. The hook puts these
  # first on PATH so a system binary (a newer Biome, or an OpenSSL whose
  # CMS signing differs) can never answer inside the gate.
  checkTools = [
    pkgs.biome
    pkgs.curl
    pkgs.git
    pkgs.jq
    pkgs.openssl
  ];

  # Runs the full precommit gate on every commit, identically from any
  # shell. The libstdc++ path rides along: the database FFI loads native
  # libraries that resolve it outside a shell, and a missing one crashes
  # the test runner partway through the suite.
  precommitHook = pkgs.writeShellApplication {
    name = "tickets-precommit-hook";
    runtimeInputs = [ deno ] ++ checkTools;
    text = ''
      ${lib.optionalString pkgs.stdenv.isLinux ''
        export LD_LIBRARY_PATH="${lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]}:''${LD_LIBRARY_PATH:-}"
      ''}
      exec ${deno}/bin/deno task precommit
    '';
  };

  # Server entrypoint for the OCI image. Fills DB_URL only when unset, so
  # an explicitly empty value stays and fails boot validation loudly.
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
      # Platforms start the image as root or as a chosen uid. When root,
      # drop to uid 1000 and prepare /data for it. A root-squashed mount
      # refuses the chown but usually stays writable — the probe below
      # rejects the mounts that are actually broken.
      if [ "$(id -u)" -eq 0 ]; then
        mkdir -p /data
        chown -R 1000:1000 /data 2>/dev/null || true
        exec setpriv --reuid=1000 --regid=1000 --clear-groups "$0" "$@"
      fi
      # The container's root filesystem is a writable union, so Deno writes
      # its analysis caches into the baked module cache directly.
      export DENO_DIR=/deno-cache
      export DB_URL="''${DB_URL-file:/data/tickets.db}"
      # SQLite needs a writable directory for its journal and a writable
      # database file when it exists. test -w answers access(2) as this
      # uid — touch would lie for a file's owner.
      case "$DB_URL" in
        file:/*)
          db_file="''${DB_URL#file:}"
          db_dir="$(dirname "$db_file")"
          # Probe what SQLite needs: a writable directory for its journal
          # and page files, and a writable database file when it exists.
          # test -w answers access(2) as this uid — touch would lie for
          # a file's owner, because an owner may set timestamps on a file
          # that no process can write.
          if ! [ -w "$db_dir" ]; then
            echo "The local database directory $db_dir is not writable by uid $(id -u). Check the data volume's permissions." >&2
            exit 1
          fi
          if [ -e "$db_file" ] && ! [ -w "$db_file" ]; then
            echo "The local database file $db_file is not writable by uid $(id -u). Check the data volume's permissions." >&2
            exit 1
          fi
          ;;
      esac
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

    # The app tree carries the built static assets. The e2e-payments
    # workspace member config ships too: Deno refuses to load deno.json
    # without every declared workspace member present.
    appTree = pkgs.runCommand "tickets-app" { } ''
    mkdir -p $out/app/e2e-payments
    cp -r ${./src} $out/app/src
    cp ${./deno.json} $out/app/deno.json
    cp ${./deno.lock} $out/app/deno.lock
    cp ${./e2e-payments/deno.json} $out/app/e2e-payments/deno.json
    chmod -R ugo+rX $out
  '';

  # Produced by container-build before the image is assembled (the Nix
  # sandbox blocks the network the cache needs). Kept as its own derivation
  # so it layers separately from the app tree.
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
    # dockerTools merges `contents` with a per-file symlinkJoin: every
    # file becomes a symlink into /nix/store. Deno follows realpaths and
    # dies classifying them, so replace both trees with real files.
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
      # Nix strips write bits when registering store paths. The module
      # cache and data volume must work for a platform-selected uid too,
      # because Deno writes analysis entries at startup.
      chmod -R u+w ./app
      chmod -R ugo+rwX ./deno-cache ./data
      chown -R 1000:1000 ./app ./deno-cache ./data
    '';
    config = {
      Env = [ "DENO_DIR=/deno-cache" ];
      # tini reaps zombies and forwards signals, so SIGTERM stops Deno
      # cleanly. Without it Deno runs as PID 1 and ignores SIGTERM.
      Entrypoint = [
        "${pkgs.tini}/bin/tini"
        "--"
        "${serverStart}/bin/tickets-server"
      ];
      WorkingDir = "/app";
      ExposedPorts = {
        "3000/tcp" = { };
      };
      # A run without an explicit volume keeps its data in Docker-managed
      # storage instead of the replaceable container layer.
      Volumes = {
        "/data" = { };
      };
      # Probe localhost:3000 every 30s, 5s budget, 10s grace, 3 strikes.
      # The engine execs the array without a shell, so Deno needs its
      # absolute path. /health answers before setup is complete.
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
      checkTools
      ++ lib.optionals (!config.container.isBuilding) (
        [
          pkgs.gh
        ]
        ++ lib.optionals (config.ticketsBrowserTools && pkgs.stdenv.isLinux)
          [ pkgs.chromium ]
      );

  # The self-host image: `container-build` assembles it (running the Deno
  # steps first), `container-load` streams it into Docker/Podman.
  scripts = {
    pc.exec = ''exec deno task precommit "$@"'';
    # Builds the static assets and the module cache, then assembles the
    # OCI image. Both Deno steps run in the shell because the Nix sandbox
    # blocks the network they need.
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
    # Boots the loaded image and proves the server answers, then checks
    # SIGTERM stops the container cleanly. Run after container-load.
    container-check.exec = ''
      set -euo pipefail
      engine="$(command -v podman || command -v docker)"
      container="tickets-verify"
      key="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
      "$engine" rm -f "$container" >/dev/null 2>&1 || true
      cleanup() { "$engine" rm -f "$container" >/dev/null 2>&1 || true; }
      trap cleanup EXIT
      "$engine" run -d --name "$container" -p 127.0.0.1:13000:3000 \
        -e DB_ENCRYPTION_KEY="$key" \
        ghcr.io/chobbledotcom/tickets:latest
      for _ in $(seq 1 20); do
        if [ "$(curl -fsS -m 5 http://127.0.0.1:13000/health 2>/dev/null)" = "Up :)" ]; then
          echo "Server answered /health."
          home="$(curl -sS -m 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:13000/)"
          setup="$(curl -sS -m 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:13000/setup)"
          if [ "$home" != "503" ] || [ "$setup" != "200" ]; then
            echo "Expected home 503 (got $home) and setup 200 (got $setup). Logs:" >&2
            "$engine" logs "$container" || true
            exit 1
          fi
          echo "Server answered home 503 and setup 200."
          "$engine" stop --time 5 "$container" >/dev/null
          exit_code="$("$engine" inspect --format '{{.State.ExitCode}}' "$container")"
          if [ "$exit_code" = "137" ]; then
            echo "Container required SIGKILL after SIGTERM. tini may be missing or broken." >&2
            "$engine" logs "$container" || true
            exit 1
          fi
          echo "Container stopped on SIGTERM (exit $exit_code)."
          exit 0
        fi
        sleep 3
      done
      echo "The image did not serve /health within a minute. Logs:" >&2
      "$engine" logs "$container" || true
      exit 1
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
    echo "  container-check      - boot the image and verify it serves"
    # Keep the module cache outside the tree: Biome discovers nested
    # biome.json files project-wide and fails on the broken extends that
    # npm packages (for example @cucumber/gherkin) ship.
    export DENO_DIR="$HOME/.cache/deno"
    # Throwaway defaults for a fresh checkout. ''${VAR-...} fills in only
    # an unset variable, so the caller's own value wins — even a
    # deliberately empty one, which must fail startup validation.
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
