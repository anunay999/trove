#!/usr/bin/env bash
# bench/setup.sh — clone MemoryBench and register the Trove provider in it.
#
# The provider lives in this repo (bench/providers/trove) and is symlinked into
# the MemoryBench checkout, so it stays version-controlled with the code it
# benchmarks and survives `git pull` upstream. Re-run this after bumping the
# pinned commit.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKOUT="${MEMORYBENCH_DIR:-$REPO_ROOT/bench/.memorybench}"
# Pin so results stay reproducible. 118209a is the commit whose provider
# interface and scoring path were audited (see bench/README.md). Bump
# deliberately, and re-read src/orchestrator/phases/{evaluate,report}.ts and
# src/providers/index.ts when you do — the registration patches below assume
# that layout and will fail loudly if it changes.
PIN="${MEMORYBENCH_COMMIT:-118209a}"

if [ ! -d "$CHECKOUT/.git" ]; then
  echo "==> cloning memorybench into $CHECKOUT"
  git clone https://github.com/supermemoryai/memorybench "$CHECKOUT"
fi

cd "$CHECKOUT"
git fetch origin --quiet
git checkout --quiet "$PIN"
echo "==> memorybench at $(git rev-parse --short HEAD)"

echo "==> linking Trove provider"
rm -rf "$CHECKOUT/src/providers/trove"
ln -s "$REPO_ROOT/bench/providers/trove" "$CHECKOUT/src/providers/trove"

# --- register the provider. MemoryBench needs four in-place edits (its
# src/providers/README.md lists three and omits the config one, which throws
# "Unknown provider" at run time if you miss it). All four are idempotent so a
# fresh clone is a single command and re-running after an upstream bump is safe.

# 1. Extend the ProviderName union.
if ! grep -q '"trove"' src/types/provider.ts; then
  perl -0pi -e 's/(export type ProviderName =.*?)"rag"/$1"rag" | "trove"/s' src/types/provider.ts
  echo "    patched src/types/provider.ts (ProviderName)"
fi

# 2. Import the class into the provider registry.
if ! grep -q 'from "./trove"' src/providers/index.ts; then
  perl -0pi -e 's|(import \{ RAGProvider \} from "./rag"\n)|$1import { TroveProvider } from "./trove"\n|' src/providers/index.ts
  echo "    patched src/providers/index.ts (import)"
fi

# 3. Add it to the `providers` Record — without this createProvider() throws.
if ! grep -q '^  trove: TroveProvider,' src/providers/index.ts; then
  perl -0pi -e 's|(\n  rag: RAGProvider,\n)|$1  trove: TroveProvider,\n|' src/providers/index.ts
  echo "    patched src/providers/index.ts (registry)"
fi

# 4. Add a getProviderConfig case — its default branch throws on unknown names.
#    Trove reads its own DB config from env; the apiKey is the OpenAI key used
#    for write-time extraction.
if ! grep -q 'case "trove"' src/utils/config.ts; then
  perl -0pi -e 's|(\n    case "rag":\n[^\n]*\n)|$1    case "trove":\n      return { apiKey: config.openaiApiKey } // Trove uses OpenAI for write-time extraction\n|' src/utils/config.ts
  echo "    patched src/utils/config.ts (getProviderConfig)"
fi

# 5. UPSTREAM BUG: the orchestrator drops questionDate.
#    The LongMemEval loader puts it in metadata.questionDate
#    (benchmarks/longmemeval/index.ts), checkpoint.initQuestion accepts it, and
#    every answerPrompt renders "Question Date: ...". Only the caller fails to
#    forward it, so every question is answered with no notion of "today" and the
#    temporal-reasoning category is unanswerable regardless of retrieval quality.
if ! grep -q "questionDate: q.metadata" src/orchestrator/index.ts; then
  perl -0pi -e 's|(\n(\s+)questionType: q\.questionType,\n)|$1$2questionDate: q.metadata?.questionDate as string \| undefined,\n|' src/orchestrator/index.ts
  echo "    patched src/orchestrator/index.ts (forward questionDate)"
fi

# Verify the patches actually landed rather than trusting the regexes.
missing=""
grep -q "questionDate: q.metadata" src/orchestrator/index.ts || missing="$missing questionDate"
grep -q '"trove"' src/types/provider.ts || missing="$missing ProviderName"
grep -q '^  trove: TroveProvider,' src/providers/index.ts || missing="$missing registry"
grep -q 'case "trove"' src/utils/config.ts || missing="$missing config"
if [ -n "$missing" ]; then
  echo "!! registration incomplete:$missing" >&2
  echo "!! upstream layout probably changed — apply the edits in src/providers/README.md by hand." >&2
  exit 1
fi
echo "==> provider registered"

cat <<'EOF'

==> done. Next:

    createdb -h localhost -p 5433 trove_bench
    TROVE_BENCH_DATABASE_URL=postgres://trove:trove@localhost:5433/trove_bench \
      npm run db:schema && npm run db:migrate

    cd bench/.memorybench
    bun install
    bun run src/index.ts compare -p trove,rag -b longmemeval -j gpt-4o --limit 25

Start with --limit 25. See bench/README.md for methodology and cost.
EOF
