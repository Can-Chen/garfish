import { Loader, ModuleManager } from '@garfish/loader';
import { assert, isObject, deepMerge } from '@garfish/utils';
import { loadModule } from './apis/loadModule';

export type ModuleConfig = Required<
  Omit<ModuleInfo, 'url' | 'version'> & { alias: Record<string, string> }
>;

export interface ModuleInfo {
  url: string;
  cache?: boolean;
  version?: string;
  externals?: Record<string, any>;
  error?: (err: Error, info: ModuleInfo, alias: string) => any;
  adapter?: (cjsModule: Record<string, any>) => Record<string, any>;
}

export let currentApp = null;
export let resourcesStore: Array<ModuleManager> = [];
export const cacheModules = Object.create(null);
export const fetchLoading = Object.create(null);
export const moduleConfig: ModuleConfig = {
  alias: {},
  cache: true, // Default use cache
  error: null,
  adapter: null,
  externals: {
    loadModule, // Only `loadModule` is provided for use by remote modules
  },
};

// If garfish has pre-prepared data
let garfishGlobalEnv;
try {
  // @ts-ignore
  garfishGlobalEnv = __GARFISH_GLOBAL_ENV__;

  // Inherit the configuration from garfish
  if (isObject(garfishGlobalEnv)) {
    const { externals, currentApp: app, remoteModulesCode } = garfishGlobalEnv;
    if (app) {
      currentApp = app;
    }
    if (isObject(externals)) {
      moduleConfig.externals = { ...externals };
    }
    if (Array.isArray(remoteModulesCode)) {
      resourcesStore = resourcesStore.concat(remoteModulesCode);
      remoteModulesCode.forEach((manager) => {
        if (manager.alias) {
          moduleConfig.alias[manager.alias] = manager.url;
        }
      });
    }
  }
} catch {}

export const loader: Loader = (() => {
  if (isObject(garfishGlobalEnv)) {
    const loader = garfishGlobalEnv.loader;
    // Garfish loader will have an identifier
    if (
      isObject(loader) &&
      loader.personalId === Symbol.for('garfish.loader')
    ) {
      return loader;
    }
  }
  return new Loader();
})();

export const getModuleCode = (url: string) => {
  // It should be noted that if there is a redirect, `manager.url` is the url after the redirect
  return resourcesStore.find((manager) => manager.url === url);
};

export const purifyOptions = (options: ModuleInfo | string) => {
  assert(options, 'Missing url for loading remote module');
  if (typeof options === 'string') {
    options = { url: options };
  }
  return deepMerge(moduleConfig, options) as ModuleInfo;
};

export const prettifyError = (
  error: Error | string,
  alias: string,
  url: string,
) => {
  const tipMarkers = [currentApp && currentApp.name, alias, url];
  let prefix = tipMarkers.reduce((msg, val, i) => {
    if (!val) return msg;
    return i === tipMarkers.length - 1
      ? msg + `"${val}"`
      : msg + `"${val}" -> `;
  }, 'remoteModule: ');
  prefix = ` (${prefix})`;

  if (typeof error === 'number') {
    error = String(error);
  }
  if (typeof error === 'string') {
    if (!error.endsWith(prefix)) {
      return `${error}${prefix}`;
    }
  }
  if (error instanceof Error) {
    if (!error.message.endsWith(prefix)) {
      error.message = `${error.message}${prefix}`;
    }
  }
  return error;
};
