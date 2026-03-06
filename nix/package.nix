{lib, fetchurl, stdenvNoCC}:
let
  sources = builtins.fromJSON (builtins.readFile ./sources.json);

  assetBySystem = {
    aarch64-darwin = "agent-slack-darwin-arm64";
    x86_64-darwin = "agent-slack-darwin-x64";
    aarch64-linux = "agent-slack-linux-arm64";
    x86_64-linux = "agent-slack-linux-x64";
  };

  system = stdenvNoCC.hostPlatform.system;

  asset =
    assetBySystem.${system}
    or (throw "agent-slack: unsupported system '${system}'");

  hash =
    sources.hashes.${system}
    or (throw "agent-slack: missing hash for system '${system}' in nix/sources.json");
in
  stdenvNoCC.mkDerivation {
    pname = "agent-slack";
    inherit (sources) version;

    src = fetchurl {
      url = "https://github.com/stablyai/agent-slack/releases/download/v${sources.version}/${asset}";
      inherit hash;
    };

    dontUnpack = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 "$src" "$out/bin/agent-slack"
      runHook postInstall
    '';

    meta = {
      description = "Slack automation CLI for AI agents";
      homepage = "https://github.com/stablyai/agent-slack";
      license = lib.licenses.mit;
      platforms = builtins.attrNames assetBySystem;
      mainProgram = "agent-slack";
      sourceProvenance = with lib.sourceTypes; [binaryNativeCode];
    };
  }
