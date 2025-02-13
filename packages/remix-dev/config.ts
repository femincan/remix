import { execSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fse from "fs-extra";
import getPort from "get-port";
import NPMCliPackageJson from "@npmcli/package-json";
import { coerce } from "semver";

import type { RouteManifest, DefineRoutesFunction } from "./config/routes";
import { defineRoutes } from "./config/routes";
import { defineConventionalRoutes } from "./config/routesConvention";
import { ServerMode, isValidServerMode } from "./config/serverModes";
import { serverBuildVirtualModule } from "./compiler/server/virtualModules";
import { flatRoutes } from "./config/flat-routes";
import { detectPackageManager } from "./cli/detectPackageManager";
import { warnOnce } from "./warnOnce";

export interface RemixMdxConfig {
  rehypePlugins?: any[];
  remarkPlugins?: any[];
}

export type RemixMdxConfigFunction = (
  filename: string
) => Promise<RemixMdxConfig | undefined> | RemixMdxConfig | undefined;

export type ServerBuildTarget =
  | "node-cjs"
  | "arc"
  | "netlify"
  | "vercel"
  | "cloudflare-pages"
  | "cloudflare-workers"
  | "deno";

export type ServerModuleFormat = "esm" | "cjs";
export type ServerPlatform = "node" | "neutral";

type Dev = {
  command?: string;
  scheme?: string;
  host?: string;
  port?: number;
  restart?: boolean;
  tlsKey?: string;
  tlsCert?: string;
};

interface FutureConfig {
  unstable_dev: boolean | Dev;
  /** @deprecated Use the `postcss` config option instead */
  unstable_postcss: boolean;
  /** @deprecated Use the `tailwind` config option instead */
  unstable_tailwind: boolean;
  v2_errorBoundary: boolean;
  v2_headers: boolean;
  v2_meta: boolean;
  v2_normalizeFormMethod: boolean;
  v2_routeConvention: boolean;
}

/**
 * The user-provided config in `remix.config.js`.
 */
export interface AppConfig {
  /**
   * The path to the `app` directory, relative to `remix.config.js`. Defaults
   * to `"app"`.
   */
  appDirectory?: string;

  /**
   * The path to a directory Remix can use for caching things in development,
   * relative to `remix.config.js`. Defaults to `".cache"`.
   */
  cacheDirectory?: string;

  /**
   * A function for defining custom routes, in addition to those already defined
   * using the filesystem convention in `app/routes`. Both sets of routes will
   * be merged.
   */
  routes?: (
    defineRoutes: DefineRoutesFunction
  ) => Promise<ReturnType<DefineRoutesFunction>>;

  /**
   * The path to the browser build, relative to `remix.config.js`. Defaults to
   * "public/build".
   */
  assetsBuildDirectory?: string;

  /**
   * The path to the browser build, relative to remix.config.js. Defaults to
   * "public/build".
   *
   * @deprecated Use `{@link AppConfig.assetsBuildDirectory}` instead
   */
  browserBuildDirectory?: string;

  /**
   * The URL prefix of the browser build with a trailing slash. Defaults to
   * `"/build/"`. This is the path the browser will use to find assets.
   */
  publicPath?: string;

  /**
   * The port number to use for the dev server. Defaults to 8002.
   */
  devServerPort?: number;

  /**
   * The delay, in milliseconds, before the dev server broadcasts a reload
   * event. There is no delay by default.
   */
  devServerBroadcastDelay?: number;

  /**
   * Additional MDX remark / rehype plugins.
   */
  mdx?: RemixMdxConfig | RemixMdxConfigFunction;

  /**
   * Whether to process CSS using PostCSS if `postcss.config.js` is present.
   * Defaults to `false`.
   */
  postcss?: boolean;

  /**
   * A server entrypoint, relative to the root directory that becomes your
   * server's main module. If specified, Remix will compile this file along with
   * your application into a single file to be deployed to your server. This
   * file can use either a `.js` or `.ts` file extension.
   */
  server?: string;

  /**
   * The path to the server build, relative to `remix.config.js`. Defaults to
   * "build".
   *
   * @deprecated Use {@link AppConfig.serverBuildPath} instead.
   */
  serverBuildDirectory?: string;

  /**
   * The path to the server build file, relative to `remix.config.js`. This file
   * should end in a `.js` extension and should be deployed to your server.
   */
  serverBuildPath?: string;

  /**
   * The target of the server build. Defaults to "node-cjs".
   *
   * @deprecated Use a combination of `{@link AppConfig.publicPath}`, `{@link AppConfig.serverBuildPath}`, `{@link AppConfig.serverConditions}`, `{@link AppConfig.serverDependenciesToBundle}`, `{@link AppConfig.serverMainFields}`, `{@link AppConfig.serverMinify}`, `{@link AppConfig.serverModuleFormat}` and/or `{@link AppConfig.serverPlatform}` instead.
   */
  serverBuildTarget?: ServerBuildTarget;

  /**
   * The order of conditions to use when resolving server dependencies'
   * `exports` field in `package.json`.
   *
   * For more information, see: https://esbuild.github.io/api/#conditions
   */
  serverConditions?: string[];

  /**
   * A list of patterns that determined if a module is transpiled and included
   * in the server bundle. This can be useful when consuming ESM only packages
   * in a CJS build.
   */
  serverDependenciesToBundle?: "all" | Array<string | RegExp>;

  /**
   * The order of main fields to use when resolving server dependencies.
   * Defaults to `["main", "module"]`.
   *
   * For more information, see: https://esbuild.github.io/api/#main-fields
   */
  serverMainFields?: string[];

  /**
   * Whether to minify the server build in production or not.
   * Defaults to `false`.
   */
  serverMinify?: boolean;

  /**
   * The output format of the server build. Defaults to "cjs".
   */
  serverModuleFormat?: ServerModuleFormat;

  /**
   * The platform the server build is targeting. Defaults to "node".
   */
  serverPlatform?: ServerPlatform;

  /**
   * Whether to support Tailwind functions and directives in CSS files if `tailwindcss` is installed.
   * Defaults to `false`.
   */
  tailwind?: boolean;

  /**
   * A list of filenames or a glob patterns to match files in the `app/routes`
   * directory that Remix will ignore. Matching files will not be recognized as
   * routes.
   */
  ignoredRouteFiles?: string[];

  /**
   * A function for defining custom directories to watch while running `remix dev`, in addition to `appDirectory`.
   */
  watchPaths?:
    | string
    | string[]
    | (() => Promise<string | string[]> | string | string[]);

  future?: Partial<FutureConfig>;
}

/**
 * Fully resolved configuration object we use throughout Remix.
 */
export interface RemixConfig {
  /**
   * The absolute path to the root of the Remix project.
   */
  rootDirectory: string;

  /**
   * The absolute path to the application source directory.
   */
  appDirectory: string;

  /**
   * The absolute path to the cache directory.
   */
  cacheDirectory: string;

  /**
   * The path to the entry.client file, relative to `config.appDirectory`.
   */
  entryClientFile: string;

  /**
   * The absolute path to the entry.client file.
   */
  entryClientFilePath: string;

  /**
   * The path to the entry.server file, relative to `config.appDirectory`.
   */
  entryServerFile: string;

  /**
   * The absolute path to the entry.server file.
   */
  entryServerFilePath: string;

  /**
   * An object of all available routes, keyed by route id.
   */
  routes: RouteManifest;

  /**
   * The absolute path to the assets build directory.
   */
  assetsBuildDirectory: string;

  /**
   * the original relative path to the assets build directory
   */
  relativeAssetsBuildDirectory: string;

  /**
   * The URL prefix of the public build with a trailing slash.
   */
  publicPath: string;

  /**
   * The port number to use for the dev (asset) server.
   */
  devServerPort: number;

  /**
   * The delay before the dev (asset) server broadcasts a reload event.
   */
  devServerBroadcastDelay: number;

  /**
   * Additional MDX remark / rehype plugins.
   */
  mdx?: RemixMdxConfig | RemixMdxConfigFunction;

  /**
   * Whether to process CSS using PostCSS if `postcss.config.js` is present.
   * Defaults to `false`.
   */
  postcss: boolean;

  /**
   * The path to the server build file. This file should end in a `.js`.
   */
  serverBuildPath: string;

  /**
   * The target of the server build. Defaults to "node-cjs".
   *
   * @deprecated Use a combination of `{@link AppConfig.publicPath}`, `{@link AppConfig.serverBuildPath}`, `{@link AppConfig.serverConditions}`, `{@link AppConfig.serverDependenciesToBundle}`, `{@link AppConfig.serverMainFields}`, `{@link AppConfig.serverMinify}`, `{@link AppConfig.serverModuleFormat}` and/or `{@link AppConfig.serverPlatform}` instead.   */
  serverBuildTarget?: ServerBuildTarget;

  /**
   * The default entry module for the server build if a {@see AppConfig.server}
   * is not provided.
   */
  serverBuildTargetEntryModule: string;

  /**
   * The order of conditions to use when resolving server dependencies'
   * `exports` field in `package.json`.
   *
   * For more information, see: https://esbuild.github.io/api/#conditions
   */
  serverConditions?: string[];

  /**
   * A list of patterns that determined if a module is transpiled and included
   * in the server bundle. This can be useful when consuming ESM only packages
   * in a CJS build.
   */
  serverDependenciesToBundle: "all" | Array<string | RegExp>;

  /**
   * A server entrypoint relative to the root directory that becomes your
   * server's main module.
   */
  serverEntryPoint?: string;

  /**
   * The order of main fields to use when resolving server dependencies.
   * Defaults to `["main", "module"]`.
   *
   * For more information, see: https://esbuild.github.io/api/#main-fields
   */
  serverMainFields: string[];

  /**
   * Whether to minify the server build in production or not.
   * Defaults to `false`.
   */
  serverMinify: boolean;

  /**
   * The mode to use to run the server.
   */
  serverMode: ServerMode;

  /**
   * The output format of the server build. Defaults to "cjs".
   */
  serverModuleFormat: ServerModuleFormat;

  /**
   * The platform the server build is targeting. Defaults to "node".
   */
  serverPlatform: ServerPlatform;

  /**
   * Whether to support Tailwind functions and directives in CSS files if `tailwindcss` is installed.
   * Defaults to `false`.
   */
  tailwind: boolean;

  /**
   * A list of directories to watch.
   */
  watchPaths: string[];

  /**
   * The path for the tsconfig file, if present on the root directory.
   */
  tsconfigPath: string | undefined;

  future: FutureConfig;
}

/**
 * Returns a fully resolved config object from the remix.config.js in the given
 * root directory.
 */
export async function readConfig(
  remixRoot?: string,
  serverMode = ServerMode.Production
): Promise<RemixConfig> {
  if (!isValidServerMode(serverMode)) {
    throw new Error(`Invalid server mode "${serverMode}"`);
  }

  if (!remixRoot) {
    remixRoot = process.env.REMIX_ROOT || process.cwd();
  }

  let rootDirectory = path.resolve(remixRoot);
  let configFile = findConfig(rootDirectory, "remix.config", configExts);

  let appConfig: AppConfig = {};
  if (configFile) {
    let appConfigModule: any;
    try {
      // shout out to next
      // https://github.com/vercel/next.js/blob/b15a976e11bf1dc867c241a4c1734757427d609c/packages/next/server/config.ts#L748-L765
      if (process.env.NODE_ENV === "test") {
        // dynamic import does not currently work inside of vm which
        // jest relies on so we fall back to require for this case
        // https://github.com/nodejs/node/issues/35889
        appConfigModule = require(configFile);
      } else {
        appConfigModule = await import(pathToFileURL(configFile).href);
      }
      appConfig = appConfigModule?.default || appConfigModule;
    } catch (error: unknown) {
      throw new Error(
        `Error loading Remix config at ${configFile}\n${String(error)}`
      );
    }
  }

  if (appConfig.serverBuildTarget) {
    warnOnce(serverBuildTargetWarning, "v2_serverBuildTarget");
  }

  if (!appConfig.future?.v2_errorBoundary) {
    warnOnce(errorBoundaryWarning, "v2_errorBoundary");
  }

  if (!appConfig.future?.v2_normalizeFormMethod) {
    warnOnce(formMethodWarning, "v2_normalizeFormMethod");
  }

  if (!appConfig.future?.v2_meta) {
    warnOnce(metaWarning, "v2_meta");
  }

  if (!appConfig.future?.v2_headers) {
    warnOnce(headersWarning, "v2_headers");
  }

  let isCloudflareRuntime = ["cloudflare-pages", "cloudflare-workers"].includes(
    appConfig.serverBuildTarget ?? ""
  );
  let isDenoRuntime = appConfig.serverBuildTarget === "deno";

  let serverBuildPath = resolveServerBuildPath(rootDirectory, appConfig);
  let serverBuildTarget = appConfig.serverBuildTarget;
  let serverBuildTargetEntryModule = `export * from ${JSON.stringify(
    serverBuildVirtualModule.id
  )};`;
  let serverConditions = appConfig.serverConditions;
  let serverDependenciesToBundle = appConfig.serverDependenciesToBundle || [];
  let serverEntryPoint = appConfig.server;
  let serverMainFields = appConfig.serverMainFields;
  let serverMinify = appConfig.serverMinify;

  if (!appConfig.serverModuleFormat) {
    warnOnce(serverModuleFormatWarning, "serverModuleFormatWarning");
  }

  let serverModuleFormat = appConfig.serverModuleFormat || "cjs";
  let serverPlatform = appConfig.serverPlatform || "node";
  if (isCloudflareRuntime) {
    serverConditions ??= ["worker"];
    serverDependenciesToBundle = "all";
    serverMainFields ??= ["browser", "module", "main"];
    serverMinify ??= true;
    serverModuleFormat = "esm";
    serverPlatform = "neutral";
  }
  if (isDenoRuntime) {
    serverConditions ??= ["deno", "worker"];
    serverDependenciesToBundle = "all";
    serverMainFields ??= ["module", "main"];
    serverModuleFormat = "esm";
    serverPlatform = "neutral";
  }
  serverMainFields ??=
    serverModuleFormat === "esm" ? ["module", "main"] : ["main", "module"];
  serverMinify ??= false;

  if (appConfig.future) {
    if ("unstable_cssModules" in appConfig.future) {
      warnOnce(
        'The "future.unstable_cssModules" config option has been removed as this feature is now enabled automatically.'
      );
    }

    if ("unstable_cssSideEffectImports" in appConfig.future) {
      warnOnce(
        'The "future.unstable_cssSideEffectImports" config option has been removed as this feature is now enabled automatically.'
      );
    }

    if ("unstable_vanillaExtract" in appConfig.future) {
      warnOnce(
        'The "future.unstable_vanillaExtract" config option has been removed as this feature is now enabled automatically.'
      );
    }

    if (appConfig.future.unstable_postcss !== undefined) {
      warnOnce(
        'The "future.unstable_postcss" config option has been deprecated as this feature is now considered stable. Use the "postcss" config option instead.'
      );
    }

    if (appConfig.future.unstable_tailwind !== undefined) {
      warnOnce(
        'The "future.unstable_tailwind" config option has been deprecated as this feature is now considered stable. Use the "tailwind" config option instead.'
      );
    }
  }

  let mdx = appConfig.mdx;
  let postcss =
    appConfig.postcss ?? appConfig.future?.unstable_postcss === true;
  let tailwind =
    appConfig.tailwind ?? appConfig.future?.unstable_tailwind === true;

  let appDirectory = path.resolve(
    rootDirectory,
    appConfig.appDirectory || "app"
  );

  let cacheDirectory = path.resolve(
    rootDirectory,
    appConfig.cacheDirectory || ".cache"
  );

  let defaultsDirectory = path.resolve(__dirname, "config", "defaults");

  let userEntryClientFile = findEntry(appDirectory, "entry.client");
  let userEntryServerFile = findEntry(appDirectory, "entry.server");

  let entryServerFile: string;
  let entryClientFile: string;

  let pkgJson = await NPMCliPackageJson.load(remixRoot);
  let deps = pkgJson.content.dependencies ?? {};

  if (userEntryServerFile) {
    entryServerFile = userEntryServerFile;
  } else {
    let serverRuntime = deps["@remix-run/deno"]
      ? "deno"
      : deps["@remix-run/cloudflare"]
      ? "cloudflare"
      : deps["@remix-run/node"]
      ? "node"
      : undefined;

    if (!serverRuntime) {
      let serverRuntimes = [
        "@remix-run/deno",
        "@remix-run/cloudflare",
        "@remix-run/node",
      ];
      let formattedList = disjunctionListFormat.format(serverRuntimes);
      throw new Error(
        `Could not determine server runtime. Please install one of the following: ${formattedList}`
      );
    }

    let clientRenderer = deps["@remix-run/react"] ? "react" : undefined;

    if (!clientRenderer) {
      throw new Error(
        `Could not determine renderer. Please install the following: @remix-run/react`
      );
    }

    let maybeReactVersion = coerce(deps.react);
    if (!maybeReactVersion) {
      let react = ["react", "react-dom"];
      let list = conjunctionListFormat.format(react);
      throw new Error(
        `Could not determine React version. Please install the following packages: ${list}`
      );
    }

    let type: "stream" | "string" =
      maybeReactVersion.major >= 18 || maybeReactVersion.raw === "0.0.0"
        ? "stream"
        : "string";

    if (!deps["isbot"] && type === "stream") {
      console.log(
        "adding `isbot` to your package.json, you should commit this change"
      );

      pkgJson.update({
        dependencies: {
          ...pkgJson.content.dependencies,
          isbot: "latest",
        },
      });

      await pkgJson.save();

      let packageManager = detectPackageManager() ?? "npm";

      execSync(`${packageManager} install`, {
        cwd: remixRoot,
        stdio: "inherit",
      });
    }

    entryServerFile = `${serverRuntime}/entry.server.${clientRenderer}-${type}.tsx`;
  }

  if (userEntryClientFile) {
    entryClientFile = userEntryClientFile;
  } else {
    let clientRenderer = deps["@remix-run/react"] ? "react" : undefined;

    if (!clientRenderer) {
      throw new Error(
        `Could not determine runtime. Please install the following: @remix-run/react`
      );
    }

    let maybeReactVersion = coerce(deps.react);
    if (!maybeReactVersion) {
      let react = ["react", "react-dom"];
      let list = conjunctionListFormat.format(react);
      throw new Error(
        `Could not determine React version. Please install the following packages: ${list}`
      );
    }

    let type: "stream" | "string" =
      maybeReactVersion.major >= 18 || maybeReactVersion.raw === "0.0.0"
        ? "stream"
        : "string";

    entryClientFile = `entry.client.${clientRenderer}-${type}.tsx`;
  }

  let entryClientFilePath = userEntryClientFile
    ? path.resolve(appDirectory, userEntryClientFile)
    : path.resolve(defaultsDirectory, entryClientFile);

  let entryServerFilePath = userEntryServerFile
    ? path.resolve(appDirectory, userEntryServerFile)
    : path.resolve(defaultsDirectory, entryServerFile);

  if (appConfig.browserBuildDirectory) {
    warnOnce(browserBuildDirectoryWarning, "browserBuildDirectory");
  }

  let assetsBuildDirectory =
    appConfig.assetsBuildDirectory ||
    appConfig.browserBuildDirectory ||
    path.join("public", "build");

  let absoluteAssetsBuildDirectory = path.resolve(
    rootDirectory,
    assetsBuildDirectory
  );

  let devServerPort =
    Number(process.env.REMIX_DEV_SERVER_WS_PORT) ||
    (await getPort({ port: Number(appConfig.devServerPort) || 8002 }));
  // set env variable so un-bundled servers can use it
  process.env.REMIX_DEV_SERVER_WS_PORT = String(devServerPort);
  let devServerBroadcastDelay = appConfig.devServerBroadcastDelay || 0;

  let defaultPublicPath =
    appConfig.serverBuildTarget === "arc" ? "/_static/build/" : "/build/";
  let publicPath = addTrailingSlash(appConfig.publicPath || defaultPublicPath);

  let rootRouteFile = findEntry(appDirectory, "root");
  if (!rootRouteFile) {
    throw new Error(`Missing "root" route file in ${appDirectory}`);
  }

  let routes: RouteManifest = {
    root: { path: "", id: "root", file: rootRouteFile },
  };

  let routesConvention: typeof flatRoutes;

  if (appConfig.future?.v2_routeConvention) {
    routesConvention = flatRoutes;
  } else {
    warnOnce(flatRoutesWarning, "v2_routeConvention");
    routesConvention = defineConventionalRoutes;
  }

  if (fse.existsSync(path.resolve(appDirectory, "routes"))) {
    let conventionalRoutes = routesConvention(
      appDirectory,
      appConfig.ignoredRouteFiles
    );
    for (let route of Object.values(conventionalRoutes)) {
      routes[route.id] = { ...route, parentId: route.parentId || "root" };
    }
  }
  if (appConfig.routes) {
    let manualRoutes = await appConfig.routes(defineRoutes);
    for (let route of Object.values(manualRoutes)) {
      routes[route.id] = { ...route, parentId: route.parentId || "root" };
    }
  }

  let watchPaths: string[] = [];
  if (typeof appConfig.watchPaths === "function") {
    let directories = await appConfig.watchPaths();
    watchPaths = watchPaths.concat(
      Array.isArray(directories) ? directories : [directories]
    );
  } else if (appConfig.watchPaths) {
    watchPaths = watchPaths.concat(
      Array.isArray(appConfig.watchPaths)
        ? appConfig.watchPaths
        : [appConfig.watchPaths]
    );
  }

  // When tsconfigPath is undefined, the default "tsconfig.json" is not
  // found in the root directory.
  let tsconfigPath: string | undefined;
  let rootTsconfig = path.resolve(rootDirectory, "tsconfig.json");
  let rootJsConfig = path.resolve(rootDirectory, "jsconfig.json");

  if (fse.existsSync(rootTsconfig)) {
    tsconfigPath = rootTsconfig;
  } else if (fse.existsSync(rootJsConfig)) {
    tsconfigPath = rootJsConfig;
  }

  let future: FutureConfig = {
    unstable_dev: appConfig.future?.unstable_dev ?? false,
    unstable_postcss: appConfig.future?.unstable_postcss === true,
    unstable_tailwind: appConfig.future?.unstable_tailwind === true,
    v2_errorBoundary: appConfig.future?.v2_errorBoundary === true,
    v2_headers: appConfig.future?.v2_headers === true,
    v2_meta: appConfig.future?.v2_meta === true,
    v2_normalizeFormMethod: appConfig.future?.v2_normalizeFormMethod === true,
    v2_routeConvention: appConfig.future?.v2_routeConvention === true,
  };

  return {
    appDirectory,
    cacheDirectory,
    entryClientFile,
    entryClientFilePath,
    entryServerFile,
    entryServerFilePath,
    devServerPort,
    devServerBroadcastDelay,
    assetsBuildDirectory: absoluteAssetsBuildDirectory,
    relativeAssetsBuildDirectory: assetsBuildDirectory,
    publicPath,
    rootDirectory,
    routes,
    serverBuildPath,
    serverBuildTarget,
    serverBuildTargetEntryModule,
    serverConditions,
    serverDependenciesToBundle,
    serverEntryPoint,
    serverMainFields,
    serverMinify,
    serverMode,
    serverModuleFormat,
    serverPlatform,
    mdx,
    postcss,
    tailwind,
    watchPaths,
    tsconfigPath,
    future,
  };
}

function addTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : path + "/";
}

const entryExts = [".js", ".jsx", ".ts", ".tsx"];

function findEntry(dir: string, basename: string): string | undefined {
  for (let ext of entryExts) {
    let file = path.resolve(dir, basename + ext);
    if (fse.existsSync(file)) return path.relative(dir, file);
  }

  return undefined;
}

const configExts = [".js", ".cjs", ".mjs"];

export function findConfig(
  dir: string,
  basename: string,
  extensions: string[]
): string | undefined {
  for (let ext of extensions) {
    let name = basename + ext;
    let file = path.join(dir, name);
    if (fse.existsSync(file)) return file;
  }

  return undefined;
}

const resolveServerBuildPath = (
  rootDirectory: string,
  appConfig: AppConfig
) => {
  let serverBuildPath = "build/index.js";

  switch (appConfig.serverBuildTarget) {
    case "arc":
      serverBuildPath = "server/index.js";
      break;
    case "cloudflare-pages":
      serverBuildPath = "functions/[[path]].js";
      break;
    case "netlify":
      serverBuildPath = ".netlify/functions-internal/server.js";
      break;
    case "vercel":
      serverBuildPath = "api/index.js";
      break;
  }

  // retain deprecated behavior for now
  if (appConfig.serverBuildDirectory) {
    warnOnce(serverBuildDirectoryWarning, "serverBuildDirectory");

    serverBuildPath = path.join(appConfig.serverBuildDirectory, "index.js");
  }

  if (appConfig.serverBuildPath) {
    serverBuildPath = appConfig.serverBuildPath;
  }

  return path.resolve(rootDirectory, serverBuildPath);
};

// adds types for `Intl.ListFormat` to the global namespace
// we could also update our `tsconfig.json` to include `lib: ["es2021"]`
declare namespace Intl {
  type ListType = "conjunction" | "disjunction";

  interface ListFormatOptions {
    localeMatcher?: "lookup" | "best fit";
    type?: ListType;
    style?: "long" | "short" | "narrow";
  }

  interface ListFormatPart {
    type: "element" | "literal";
    value: string;
  }

  class ListFormat {
    constructor(locales?: string | string[], options?: ListFormatOptions);
    format(values: any[]): string;
    formatToParts(values: any[]): ListFormatPart[];
    supportedLocalesOf(
      locales: string | string[],
      options?: ListFormatOptions
    ): string[];
  }
}

let conjunctionListFormat = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
});

let disjunctionListFormat = new Intl.ListFormat("en", {
  style: "long",
  type: "disjunction",
});

export let browserBuildDirectoryWarning =
  "⚠️ REMIX FUTURE CHANGE: The `browserBuildDirectory` config option will be removed in v2. " +
  "Use `assetsBuildDirectory` instead. " +
  "For instructions on making this change see " +
  "https://remix.run/docs/en/v1.15.0/pages/v2#browserbuilddirectory";

export let serverBuildDirectoryWarning =
  "⚠️ REMIX FUTURE CHANGE: The `serverBuildDirectory` config option will be removed in v2. " +
  "Use `serverBuildPath` instead. " +
  "For instructions on making this change see " +
  "https://remix.run/docs/en/v1.15.0/pages/v2#serverbuilddirectory";

export let serverBuildTargetWarning =
  "⚠️ REMIX FUTURE CHANGE: The `serverBuildTarget` config option will be removed in v2. " +
  "Use a combination of server module config values to achieve the same build output. " +
  "For instructions on making this change see " +
  "https://remix.run/docs/en/v1.15.0/pages/v2#serverbuildtarget";

export const serverModuleFormatWarning =
  "⚠️ REMIX FUTURE CHANGE: The `serverModuleFormat` config default option will be changing in v2 " +
  "from `cjs` to `esm`. You can prepare for this change by explicitly specifying `serverModuleFormat: 'cjs'`. " +
  "For instructions on making this change see " +
  "https://remix.run/docs/en/v1.16.0/pages/v2#servermoduleformat";

export let flatRoutesWarning =
  "⚠️ REMIX FUTURE CHANGE: The route file convention is changing in v2. " +
  "You can prepare for this change at your convenience with the `v2_routeConvention` future flag. " +
  "For instructions on making this change see " +
  "https://remix.run/docs/en/v1.15.0/pages/v2#file-system-route-convention";

export const errorBoundaryWarning =
  "⚠️ REMIX FUTURE CHANGE: The behaviors of `CatchBoundary` and `ErrorBoundary` are changing in v2. " +
  "You can prepare for this change at your convenience with the `v2_errorBoundary` future flag. " +
  "For instructions on making this change see " +
  "https://remix.run/docs/en/v1.15.0/pages/v2#catchboundary-and-errorboundary";

export const formMethodWarning =
  "⚠️ REMIX FUTURE CHANGE: APIs that provide `formMethod` will be changing in v2. " +
  "All values will be uppercase (GET, POST, etc.) instead of lowercase (get, post, etc.) " +
  "You can prepare for this change at your convenience with the `v2_normalizeFormMethod` future flag. " +
  "For instructions on making this change see " +
  "https://remix.run/docs/en/v1.15.0/pages/v2#formMethod";

export const metaWarning =
  "⚠️ REMIX FUTURE CHANGE: The route `meta` export signature is changing in v2. " +
  "You can prepare for this change at your convenience with the `v2_meta` future flag. " +
  "For instructions on making this change see " +
  "https://remix.run/docs/en/v1.15.0/pages/v2#meta";

export const headersWarning =
  "⚠️ REMIX FUTURE CHANGE: The route `headers` export behavior is changing in v2. " +
  "You can prepare for this change at your convenience with the `v2_headers` future flag. " +
  "For instructions on making this change see " +
  "https://remix.run/docs/en/v1.17.0/pages/v2#route-headers";
