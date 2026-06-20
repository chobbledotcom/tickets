{
  inputs = {
    nixpkgs.url = "nixpkgs";
    # Pinned solely to provide Deno 2.5.6 — the lowest Bunny Edge Scripting
    # runtime this project supports and the version the suite is verified
    # against. Everything else in the dev shell comes from `nixpkgs`, so only
    # Deno is held back; bump this rev when the supported floor moves.
    nixpkgs-deno.url = "github:NixOS/nixpkgs/ee09932cedcef15aaf476f9343d1dea2cb77e261";
  };

  outputs =
    { nixpkgs, nixpkgs-deno, ... }:
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
        in
        {
          default = pkgs.mkShell {
            packages = [
              deno
              (pkgs.writeShellScriptBin "pc" ''
                exec ${deno}/bin/deno task precommit "$@"
              '')
              pkgs.typescript-go
              pkgs.biome
              pkgs.openssl
              pkgs.buildah
            ];
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
              echo "  deno task precommit  - typecheck + lint + cpd + build + test"
              echo "  pc                   - run precommit"
              echo "  nix run .#docker     - build container image"
              echo "  nix run .#docker-start - build and run container"
              export DB_ENCRYPTION_KEY="$(openssl rand -base64 32)"
              export DB_URL=":memory:"
              export PORT=8080

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
