{ config, pkgs, ... }:

let
  deno = config.languages.deno.package;
  server = pkgs.writeShellApplication {
    name = "tickets-server";
    runtimeInputs = [
      deno
      pkgs.coreutils
      pkgs.util-linux
    ];
    text = builtins.readFile ../scripts/container/start.sh;
  };

  appFiles = pkgs.runCommand "tickets-app" {
    APP_SOURCE = ../src;
    DENO_CONFIG = ../deno.json;
    DENO_LOCK = ../deno.lock;
    WORKSPACE_CONFIG = ../e2e-payments/deno.json;
  } (builtins.readFile ../scripts/container/app-files.sh);

  cacheFiles = pkgs.runCommand "tickets-deno-cache" {
    CACHE_SOURCE = ../.container-work/deno-cache;
  } (builtins.readFile ../scripts/container/cache-files.sh);
in
{
  scripts = {
    container-build.exec = builtins.readFile ../scripts/container/build.sh;
    container-load.exec = builtins.readFile ../scripts/container/load.sh;
    container-check.exec = builtins.readFile ../scripts/container/check.sh;
  };

  outputs.tickets-image = pkgs.dockerTools.streamLayeredImage {
    name = "ghcr.io/chobbledotcom/tickets";
    tag = "latest";
    contents = [
      appFiles
      server
      cacheFiles
    ];
    fakeRootCommands = builtins.readFile ../scripts/container/permissions.sh;

    config = {
      Env = [ "DENO_DIR=/deno-cache" ];
      Entrypoint = [
        "${pkgs.tini}/bin/tini"
        "--"
        "${server}/bin/tickets-server"
      ];
      WorkingDir = "/app";
      ExposedPorts."3000/tcp" = { };
      Volumes."/data" = { };

      # /health also answers before site setup.
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
}
