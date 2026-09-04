import path from "node:path";
import { fileURLToPath } from "node:url";
import babel from "@babel/core";
import styleXBabelPlugin from "@stylexjs/babel-plugin";
import type { Plugin, ViteDevServer } from "vite";

/**
 * The plugin ships as CommonJS, so under nodenext the default import is the
 * module object; `processStylexRules` hangs off it but is not on the namespace
 * type. Name the one function used here rather than casting at the call site.
 */
const { processStylexRules } = styleXBabelPlugin as unknown as {
  processStylexRules: (rules: unknown[], config?: boolean) => string;
};

/**
 * Compile StyleX.
 *
 * `stylex.create()` is not a runtime call — it is a marker the compiler
 * replaces with the class names it has already written into a stylesheet. Ship
 * it uncompiled and it throws on the first render. Astryx's own components come
 * precompiled in `astryx.css`, so this only has to handle the styles this app
 * writes: the handful of `xstyle` values in the graph chat panel.
 *
 * Two halves, both here so there is one place to read:
 *
 *  - `transform` runs Babel over any of our own modules that import StyleX,
 *    rewriting the `create()` calls and handing back the rules it extracted.
 *    It runs at `enforce: "pre"`, before the React plugin's oxc pass, and only
 *    strips types — the JSX is left alone for oxc to handle as usual.
 *  - `load` answers `virtual:stylex.css` by folding every module's rules into
 *    one stylesheet, in StyleX's own priority order.
 *
 * The virtual stylesheet is imported unlayered, so an `xstyle` override beats
 * the component style it is overriding. That is safe here only because every
 * class it defines is generated from this app's own `create()` calls, and the
 * only file making those is the chat panel.
 *
 * Dev works the same way: when a module's rules change, the virtual stylesheet
 * is invalidated and Vite pushes the new CSS.
 */
export function stylex(): Plugin {
  const VIRTUAL = "virtual:stylex.css";
  const RESOLVED = `\0${VIRTUAL}`;
  const rootDir = path.dirname(fileURLToPath(import.meta.url));

  /** Extracted rules per module id, so a re-transform replaces rather than appends. */
  const rules = new Map<string, unknown[]>();
  let server: ViteDevServer | undefined;
  let isDev = false;

  const invalidate = () => {
    const mod = server?.moduleGraph.getModuleById(RESOLVED);
    if (mod) {
      server?.moduleGraph.invalidateModule(mod);
      server?.ws.send({ type: "update", updates: [] });
    }
  };

  return {
    name: "trove:stylex",
    enforce: "pre",

    configResolved(config) {
      isDev = config.command === "serve";
    },
    configureServer(dev) {
      server = dev;
    },

    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null;
    },

    load(id) {
      if (id !== RESOLVED) return null;
      const all = [...rules.values()].flat();
      // `false` = do not wrap in @layer: see the note above about xstyle.
      return processStylexRules(all, false);
    },

    async transform(code, id) {
      const file = id.split("?")[0]!;
      if (!/\.[cm]?[jt]sx?$/.test(file)) return null;
      if (file.includes("/node_modules/")) return null;
      // Cheap gate: the compiler is only interesting for modules that ask for it.
      if (!code.includes("@stylexjs/stylex")) return null;

      const result = await babel.transformAsync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        presets: [
          [
            "@babel/preset-typescript",
            { isTSX: file.endsWith("x"), allExtensions: true, onlyRemoveTypeImports: true },
          ],
        ],
        plugins: [
          [
            styleXBabelPlugin,
            {
              dev: isDev,
              // The stylesheet is a build artefact, not something injected at
              // runtime — that is the whole point of having a build step.
              runtimeInjection: false,
              unstable_moduleResolution: { type: "commonJS", rootDir },
            },
          ],
        ],
      });
      if (!result?.code) return null;

      const extracted =
        (result.metadata as { stylex?: unknown[] } | undefined)?.stylex ?? [];
      const before = JSON.stringify(rules.get(file) ?? []);
      rules.set(file, extracted);
      if (isDev && JSON.stringify(extracted) !== before) invalidate();

      return { code: result.code, map: result.map };
    },
  };
}
