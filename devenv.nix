{
  inputs,
  pkgs,
  lib,
  config,
  ...
}:

let
  # Deno stays at the supported Bunny runtime floor.
  deno = (import inputs.nixpkgs-deno { system = pkgs.stdenv.hostPlatform.system; }).deno;
  browserTools = config.ticketsBrowserTools && pkgs.stdenv.isLinux;
  checkTools = with pkgs; [
    biome
    curl
    git
    jq
    openssl
  ];

  runtimeSetup = pkgs.replaceVars ./scripts/devenv/library-path.sh {
    libraryPath = lib.optionalString pkgs.stdenv.isLinux (
      lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]
    );
  };

  precommitHook = pkgs.writeShellApplication {
    name = "tickets-precommit-hook";
    runtimeInputs = [ deno ] ++ checkTools;
    text = builtins.readFile (
      pkgs.replaceVars ./scripts/devenv/precommit.sh {
        inherit runtimeSetup;
      }
    );
  };

  shellSetup = pkgs.replaceVars ./scripts/devenv/shell.sh {
    inherit runtimeSetup;
    deno = "${deno}/bin/deno";
    denoVersion = "2.5.6";
    chromium = lib.optionalString browserTools "${pkgs.chromium}/bin/chromium";
  };
in
{
  imports = [ ./nix/container.nix ];

  options.ticketsBrowserTools = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = "Include Chromium for browser tests.";
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
        [ pkgs.gh ] ++ lib.optionals browserTools [ pkgs.chromium ]
      );

    scripts.pc.exec = ''exec deno task precommit "$@"'';

    git-hooks.hooks.precommit = {
      enable = true;
      entry = "${precommitHook}/bin/tickets-precommit-hook";
      pass_filenames = false;
    };

    enterShell = "source ${shellSetup}";
  };
}
