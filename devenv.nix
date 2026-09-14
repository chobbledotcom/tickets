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
    util-linux
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
    # CI runs each check itself, so the commit-time Git hook must not run. Every
    # shell entry otherwise runs `deno task precommit` before the command.
    profiles.ci.module = {
      ticketsBrowserTools = false;
      git-hooks.enable = false;
    };

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

    # The devenv task `devenv:git-hooks:run` executes `prek run -a` — the
    # whole `deno task precommit` — on every shell entry, which takes up to
    # 24 minutes on this tree. The commit-time Git hook and CI already run
    # the precommit, so shell entry never needs it. A `status` command that
    # exits 0 tells the task runner the hook run is already satisfied, so the
    # entry task skips without disabling the hooks themselves. The check runs
    # only where the git-hooks module defines the task: the ci profile turns
    # the module off, and a status-only leftover task there would fail to
    # evaluate.
    tasks = lib.mkIf config.git-hooks.enable {
      "devenv:git-hooks:run".status = "exit 0";
    };

    enterShell = "source ${shellSetup}";
  };
}
