{
  inputs.nixpkgs.url = "nixpkgs";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      eachSystem = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in {
      devShells = eachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.deno ];
          shellHook = ''
            echo "tickets dev shell"
            echo "  deno task start      - run server"
            echo "  deno task test       - run tests"
            echo "  deno task build:edge - build for edge"
            echo "  deno task precommit  - typecheck + lint + cpd + build + test"
          '';
        };
      });
    };
}
