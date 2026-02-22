{
  inputs.nixpkgs.url = "nixpkgs";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      eachSystem = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      devShells = eachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.deno
            pkgs.openssl
            pkgs.buildah
          ];
          shellHook = ''
            echo "tickets dev shell"
            echo "  deno task start      - run server"
            echo "  deno task test       - run tests"
            echo "  deno task build:edge - build for edge"
            echo "  deno task precommit  - typecheck + lint + cpd + build + test"
            echo "  nix run .#docker     - build container image"
            echo "  nix run .#docker-start - build and run container"
            export DB_ENCRYPTION_KEY="$(openssl rand -base64 32)"
            export DB_URL=":memory:"
            export PORT=8080
            export ALLOWED_DOMAIN="localhost"
          '';
        };
      });

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
