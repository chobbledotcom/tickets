{
  inputs = {
    nixpkgs.url = "nixpkgs";
    # Pinned solely to provide Deno 2.5.6 — the lowest Bunny Edge Scripting
    # runtime this project supports and the version the suite is verified
    # against. The normal `deno` command is held back; bump this rev when the
    # supported floor moves.
    nixpkgs-deno.url = "github:NixOS/nixpkgs/ee09932cedcef15aaf476f9343d1dea2cb77e261";
    # Desktop is the sole command allowed to move ahead of the production Deno
    # floor. It requires Deno 2.9.0 or newer.
    nixpkgs-desktop.url = "nixpkgs";
  };

  outputs =
    {
      nixpkgs,
      nixpkgs-deno,
      nixpkgs-desktop,
      ...
    }:
    let
      denoVersion = "2.5.6";
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      eachSystem = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      devShells = eachSystem (
        pkgs:
        let
          # Take Deno from the pinned nixpkgs so the shell uses exactly
          # ${denoVersion} regardless of what the main nixpkgs currently ships.
          deno = nixpkgs-deno.legacyPackages.${pkgs.stdenv.hostPlatform.system}.deno;
          desktopDeno =
            nixpkgs-desktop.legacyPackages.${pkgs.stdenv.hostPlatform.system}.deno;
          denoDesktop = pkgs.writeShellScriptBin "deno-desktop" ''
            export DENO_DIR="''${DENO_DESKTOP_DIR:-''${XDG_CACHE_HOME:-$HOME/.cache}/deno-desktop}"
            exec ${desktopDeno}/bin/deno "$@"
          '';
          desktopFhs = pkgs.buildFHSEnv {
            name = "tickets-desktop-fhs";
            runScript = "bash";
            targetPkgs = desktopPkgs: [
              desktopPkgs.glib
              desktopPkgs.gtk3
              desktopPkgs.libsoup_3
              desktopPkgs.webkitgtk_4_1
            ];
          };
          startDesktop = pkgs.writeShellScriptBin "start-desktop" (
            if pkgs.stdenv.isLinux then
              ''
                if [ "''${DB_URL:-}" = ":memory:" ]; then
                  data_dir="$PWD/.local-data"
                  key_file="$data_dir/desktop.key"
                  mkdir -p "$data_dir"
                  if [ ! -f "$key_file" ]; then
                    ${pkgs.openssl}/bin/openssl rand -base64 32 > "$key_file"
                  fi
                  export DB_URL="file:$data_dir/desktop.db"
                  export DB_ENCRYPTION_KEY="$(<"$key_file")"
                fi
                runtime="$PWD/dist/desktop/tickets/tickets.so"
                launcher="$PWD/dist/desktop/tickets/tickets"
                exec ${desktopFhs}/bin/tickets-desktop-fhs \
                  -c 'export LD_PRELOAD="$1"; shift; exec "$@"' -- \
                  "$runtime" "$launcher" "$@"
              ''
            else
              ''
                echo "start:desktop currently supports Linux only" >&2
                exit 1
              ''
          );
        in
        assert pkgs.lib.assertMsg (pkgs.lib.versionAtLeast desktopDeno.version "2.9.0")
          "tickets desktop builds require Deno 2.9.0 or newer, but nixpkgs provides ${desktopDeno.version}";
        {
          default = pkgs.mkShell {
            packages =
              [
                deno
                denoDesktop
                startDesktop
                (pkgs.writeShellScriptBin "pc" ''
                  exec ${deno}/bin/deno task precommit "$@"
                '')
                pkgs.biome
                pkgs.openssl
                pkgs.buildah
              ]
              ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.chromium ];
            shellHook = ''
              deno_version="$(${deno}/bin/deno --version | sed -n 's/^deno \([^ ]*\).*/\1/p')"
              if [ "$deno_version" != "${denoVersion}" ]; then
                echo "tickets requires Deno ${denoVersion}, but the pinned nixpkgs provides $deno_version" >&2
                return 1
              fi

              echo "tickets dev shell"
              echo "  deno task start      - run server"
              echo "  deno task test       - run tests"
              echo "  deno task build:edge - build for edge"
              echo "  deno task build:desktop - build the desktop app"
              echo "  deno task start:desktop - build and open the desktop app"
              echo "  deno task screenshot - capture representative pages"
              echo "  deno task precommit  - typecheck + lint + cpd + build + test"
              echo "  pc                   - run precommit"
              echo "  nix run .#docker     - build container image"
              echo "  nix run .#docker-start - build and run container"
              # Throwaway defaults for a fresh checkout. ''${VAR-...} fills in
              # only an unset variable, so the caller's own value wins — even a
              # deliberately empty one, which must fail startup validation.
              export DB_ENCRYPTION_KEY="''${DB_ENCRYPTION_KEY-$(openssl rand -base64 32)}"
              export DB_URL="''${DB_URL-:memory:}"
              export PORT="''${PORT-8080}"
              ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
                export CHROMIUM_EXECUTABLE="${pkgs.chromium}/bin/chromium"
                export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]}:''${LD_LIBRARY_PATH:-}"
              ''}

              install_precommit_hook() {
                if ! ${pkgs.git}/bin/git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
                  return
                fi

                hook_path="$(${pkgs.git}/bin/git rev-parse --git-path hooks/pre-commit)"
                hook_marker="# Installed by tickets flake.nix"

                if [ -e "$hook_path" ] && ! grep -Fqx "$hook_marker" "$hook_path"; then
                  echo "  pre-commit hook already exists; leaving it unchanged"
                  return
                fi

                mkdir -p "$(dirname "$hook_path")"
                cat > "$hook_path" <<'HOOK'
#!/usr/bin/env sh
# Installed by tickets flake.nix
exec deno task precommit
HOOK
                chmod +x "$hook_path"
                echo "  installed pre-commit hook - deno task precommit"
              }

              install_precommit_hook
            '';
          };
        }
      );

      apps = eachSystem (pkgs: {
        docker = {
          type = "app";
          program = "${pkgs.writeShellScriptBin "build-docker" ''
            ${pkgs.buildah}/bin/buildah bud -t tickets .
          ''}/bin/build-docker";
        };
        docker-start = {
          type = "app";
          program = "${pkgs.writeShellScriptBin "docker-start" ''
            set -euo pipefail
            IMAGE="tickets"
            CONTAINER="tickets"
            PORT="''${PORT:-3000}"
            VOLUME="tickets-data"

            echo "Building $IMAGE image..."
            ${pkgs.buildah}/bin/buildah bud -t "$IMAGE" .

            if ${pkgs.podman}/bin/podman container exists "$CONTAINER" 2>/dev/null; then
              echo "Stopping existing $CONTAINER container..."
              ${pkgs.podman}/bin/podman stop "$CONTAINER"
              ${pkgs.podman}/bin/podman rm "$CONTAINER"
            fi

            ${pkgs.podman}/bin/podman volume exists "$VOLUME" 2>/dev/null || \
              ${pkgs.podman}/bin/podman volume create "$VOLUME"

            echo "Starting $CONTAINER on port $PORT..."
            ${pkgs.podman}/bin/podman run -d \
              --name "$CONTAINER" \
              -p "$PORT:3000" \
              -v "$VOLUME:/data" \
              -e DB_ENCRYPTION_KEY="''${DB_ENCRYPTION_KEY:-$(${pkgs.openssl}/bin/openssl rand -base64 32)}" \
              "$IMAGE"

            echo "Container running: http://localhost:$PORT"
            echo "Logs: podman logs -f $CONTAINER"
          ''}/bin/docker-start";
        };
      });
    };
}
