// Loaded before every test file (package.json --import). A test run must never
// reach a real model: a key in the developer's shell would switch on the recall
// reranker and the reconcile judge, and exact-order assertions would then depend
// on a network call. Suites that test those clients set the keys they need.
for (const name of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENAI_BASE_URL", "TROVE_EMBEDDING_PROVIDER"]) {
  delete process.env[name];
}
