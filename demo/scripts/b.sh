#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/env.sh"
cd "$DIR"
exec node client.mjs B /bravo
