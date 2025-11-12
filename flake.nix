{
  description = "Validator Web Search - TypeScript dev shell";

  # Pin nixpkgs; lockfile controls exact revision
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs?ref=nixos-24.11";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };
        in {
          # Node/TS development shell
          default = pkgs.mkShell {
            buildInputs = [
              pkgs.nodejs_22
              pkgs.bun
              pkgs.postgresql
              pkgs.jq
              pkgs.git
            ];

            # Keep shell side-effect free beyond PATH; env vars are loaded via .envrc
            shellHook = ''
              # Make local project tools available (eslint, prettier, vitest, tsx, etc.)
              export PATH="$PWD/node_modules/.bin:$PATH"
              echo "[devshell] node $(node -v), bun $(bun --version 2>/dev/null || echo n/a)"
            '';

            # Useful defaults for source maps in Node
            env = {
              NODE_OPTIONS = "--enable-source-maps";
            };
          };
        });
    };
}
