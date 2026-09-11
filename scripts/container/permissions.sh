#!/usr/bin/env bash

# Deno's npm loader needs real files, not dockerTools' links into /nix/store.
for tree in app deno-cache; do
  mv "./$tree" "./$tree.linked"
  cp -aL "./$tree.linked" "./$tree"
  rm -rf "./$tree.linked"
done

mkdir -p ./tmp ./data
chmod 1777 ./tmp
chmod -R u+w ./app
# Deno writes cache entries as the platform-selected uid.
chmod -R ugo+rwX ./deno-cache ./data
chown -R 1000:1000 ./app ./deno-cache ./data
