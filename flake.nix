{
  description = "agent-slack: Slack automation CLI for AI agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs {inherit system;};
      agent-slack = pkgs.callPackage ./nix/package.nix {};
    in {
      packages = {
        inherit agent-slack;
        default = agent-slack;
      };

      apps = {
        default = flake-utils.lib.mkApp {
          drv = agent-slack;
          name = "agent-slack";
        };
      };
    });
}
