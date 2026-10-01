# Modell-Katalog-Snapshot

Upstream erzeugt `packages/ai/src/providers/data/` zur Build-Zeit per Netzwerk (gitignoriert).
Im Nix-Sandbox gibt es kein Netzwerk, daher liegt hier ein eingefrorener Snapshot, den
`nix/package.nix` vor dem Build an die richtige Stelle kopiert.

Aktualisieren (braucht Netzwerk, im Repo-Root):

    npm ci --ignore-scripts
    npm run hydrate:model-data
    rm -rf nix/model-data && cp -r packages/ai/src/providers/data nix/model-data
    # dann dieses README erneut anlegen (git checkout -- nix/model-data/README.md)
