import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { stylex } from "./vite-stylex.js";

export default defineConfig({
  // stylex first: it runs at enforce "pre" and strips types, leaving the JSX
  // for the react plugin exactly as it found it.
  plugins: [stylex(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/v1": "http://localhost:8787",
      "/health": "http://localhost:8787",
      "/skills": "http://localhost:8787",
    },
  },
});
