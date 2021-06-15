import { EventEmitter } from 'events';
import { Loader } from '@garfish/loader';
import {
  warn,
  error,
  assert,
  hasOwn,
  isObject,
  deepMerge,
  transformUrl,
  __GARFISH_FLAG__,
  Text,
  StyleManager,
  TemplateManager,
  JavaScriptManager,
} from '@garfish/utils';
import { Hooks } from './hooks';
import { App } from './module/app';
import { Component } from './module/component';
import { interfaces } from './interface';
import { GarfishHMRPlugin } from './plugins/fixHMR';
import { GarfishOptionsLife } from './plugins/lifecycle';
import { GarfishPreloadPlugin } from './plugins/preload';
import { defaultLoadComponentOptions, getDefaultOptions } from './config';

type GarfishPlugin = (context: Garfish) => interfaces.Plugin;
type Manager = StyleManager | TemplateManager | JavaScriptManager;

export class Garfish implements interfaces.Garfish {
  public hooks: Hooks;
  public loader: Loader;
  public running = false;
  public version = __VERSION__;
  public flag = __GARFISH_FLAG__; // A unique identifier
  public channel = new EventEmitter();
  public options = getDefaultOptions();
  public externals: Record<string, any> = {};
  public plugins: Array<interfaces.Plugin> = [];
  public cacheApps: Record<string, interfaces.App> = {};
  public activeApps: Record<string, interfaces.App> = {};
  public appInfos: Record<string, interfaces.AppInfo> = {};
  public cacheComponents: Record<string, interfaces.Component> = {};
  private loading: Record<string, Promise<any> | null> = {};

  constructor(options: interfaces.Options) {
    this.hooks = new Hooks();
    this.loader = new Loader();

    this.loader.lifecycle.loaded.add((data) => {
      const { code, result, fileType, isComponent } = data;
      if (isComponent) return data;
      // prettier-ignore
      const managerCtor =
      fileType === 'template'
        ? TemplateManager
        : fileType === 'css'
          ? StyleManager
          : fileType === 'js'
            ? JavaScriptManager
            : data;
      // Use result.url, resources may be redirected
      return managerCtor ? new managerCtor(code, result.url) : data;
    });

    // init Garfish options
    this.setOptions(options);
    // register plugins
    options?.plugins.forEach((pluginCb) => {
      this.usePlugin(pluginCb, this);
    });
    this.hooks.lifecycle.initialize.call(this.options);
  }

  private injectOptionalPlugin(options?: interfaces.Options) {
    const defaultPlugin = [GarfishHMRPlugin(), GarfishOptionsLife()];
    if (!options.disablePreloadApp) {
      defaultPlugin.push(GarfishPreloadPlugin());
    }
    defaultPlugin.forEach((pluginCb) => {
      this.usePlugin(pluginCb, this);
    });
  }

  public usePlugin(plugin: GarfishPlugin, ...args: Array<any>) {
    assert(typeof plugin === 'function', 'Plugin must be a function.');
    if ((plugin as any)._registered) {
      __DEV__ && warn('Please do not register the plugin repeatedly.');
      return this;
    }
    (plugin as any)._registered = true;
    const res = plugin.apply(this, [this, ...args]);
    this.plugins.push(res);
    return this.hooks.usePlugins(res);
  }

  setOptions(options: Partial<interfaces.Options>) {
    assert(!this.running, 'Garfish is running, can`t set options');
    if (isObject(options)) {
      this.options = deepMerge(this.options, options);
      // register apps
      this.registerApp(options.apps || []);
      // Index object can't deep copy otherwise unable to communicate
      if (hasOwn(options, 'props')) {
        this.options.props = options.props;
      }
    }
    return this;
  }

  run(options?: interfaces.Options) {
    if (this.running) {
      __DEV__ &&
        warn('Garfish is already running now, Cannot run Garfish repeatedly.');
      // Nested scene can be repeated registration application, and basic information for the basename
      this.registerApp(
        options.apps?.map((app) => {
          return {
            ...app,
            basename: options?.basename || this.options.basename,
            domGetter: options?.domGetter || this.options.domGetter,
          };
        }),
      );
      return this;
    }
    this.hooks.lifecycle.beforeBootstrap.call(this.options);
    this.setOptions(options);
    // register plugins
    options?.plugins?.forEach((pluginCb) => {
      this.usePlugin(pluginCb, this);
    });
    this.injectOptionalPlugin(options);
    this.running = true;
    this.hooks.lifecycle.bootstrap.call(this.options);
    return this;
  }

  setExternal(nameOrExtObj: string | Record<string, any>, value?: any) {
    assert(nameOrExtObj, 'Invalid parameter.');
    if (typeof nameOrExtObj === 'object') {
      for (const key in nameOrExtObj) {
        if (this.externals[key]) {
          __DEV__ && warn(`The "${key}" will be overwritten in external.`);
        }
        this.externals[key] = nameOrExtObj[key];
      }
    } else {
      this.externals[nameOrExtObj] = value;
    }
  }

  registerApp(list: interfaces.AppInfo | Array<interfaces.AppInfo>) {
    this.hooks.lifecycle.beforeRegisterApp.call(list);
    const adds = {};
    if (!Array.isArray(list)) {
      list = [list];
    }
    for (const info of list) {
      assert(info.name, 'Miss app.name.');
      if (this.appInfos[info.name]) {
        __DEV__ && warn(`The "${info.name}" app is already registered.`);
      } else {
        assert(
          info.entry,
          `${info.name} application entry is not url: ${info.entry}`,
        );
        adds[info.name] = info;
        this.appInfos[info.name] = info;
      }
    }
    this.hooks.lifecycle.registerApp.call(this.appInfos);
    return this;
  }

  async loadApp(
    appName: string,
    options: interfaces.LoadAppOptions | string,
  ): Promise<interfaces.App> {
    let appInfo = this.appInfos[appName];
    // Does not support does not have remote resources and no registered application
    assert(
      !(!appInfo && !appInfo.entry),
      `Can't load unexpected module "${appName}".` +
        'Please provide the entry parameters or registered in advance of the app',
    );

    // Deep clone app options
    if (isObject(options)) {
      const tempInfo = appInfo;
      appInfo = deepMerge(tempInfo, options);
    } else if (typeof options === 'string') {
      // Garfish.loadApp('appName', 'https://xxx.html')
      appInfo = {
        name: appName,
        entry: options,
        domGetter: () => document.createElement('div'),
      };
    }

    const asyncLoadProcess = async () => {
      // Return not undefined type data directly to end loading
      const stopLoad = await this.hooks.lifecycle.beforeLoad.promise(appInfo);
      if (stopLoad === false) {
        warn(`Load ${appName} application is terminated by beforeLoad.`);
        return null;
      }
      // Existing cache caching logic
      let appInstance = null;
      const cacheApp = this.cacheApps[appName];
      if (appInfo.cache && cacheApp) {
        appInstance = cacheApp;
      } else {
        try {
          let isHtmlMode, fakeEntryManager;
          const resources = { js: [], link: [] }; // Default resources
          const entryManager = await this.loader.load<Manager>(
            appName,
            transformUrl(location.href, appInfo.entry),
          );

          // Html entry
          if (entryManager instanceof TemplateManager) {
            isHtmlMode = true;
            // Get all script element
            const jsNodes = entryManager
              .findAllJsNodes()
              .map((node) => {
                const src = entryManager.findAttributeValue(node, 'src');
                const type = entryManager.findAttributeValue(node, 'type');

                // There should be no embedded script in the script element tag with the src attribute specified
                if (src) {
                  const fetchUrl = transformUrl(entryManager.url, src);
                  // Scripts with "async" attribute will make the rendering process very complicated,
                  // we have a preload mechanism, so we don’t need to deal with it.
                  return this.loader
                    .load<JavaScriptManager>(appName, fetchUrl)
                    .then((jsManager) => {
                      jsManager.setMimeType(type);
                      return jsManager;
                    });
                } else {
                  const code = (node.children[0] as Text).content;
                  if (code) {
                    const jsManager = new JavaScriptManager(code, '');
                    jsManager.setMimeType(type);
                    return jsManager;
                  }
                }
              })
              .filter((val) => val);

            // Get all link element
            const linkNodes = entryManager
              .findAllLinkNodes()
              .map((node) => {
                if (!entryManager.DOMApis.isCssLinkNode(node)) return;
                const href = entryManager.findAttributeValue(node, 'href');
                if (href) {
                  const fetchUrl = transformUrl(entryManager.url, href);
                  return this.loader.load<StyleManager>(appName, fetchUrl);
                }
              })
              .filter((val) => val);

            const [js, link] = await Promise.all([jsNodes, linkNodes]);
            resources.js = js;
            resources.link = link;
          } else if (entryManager instanceof JavaScriptManager) {
            // Js entry
            isHtmlMode = false;
            const mockTemplateCode = `<script src="${entryManager.url}"></script>`;
            fakeEntryManager = new TemplateManager(
              mockTemplateCode,
              entryManager.url,
            );
            resources.js = [entryManager];
          } else {
            // No other types of entrances are currently supported
            error(`Entrance wrong type of resource of "${appName}"`);
          }

          const manager = fakeEntryManager || entryManager;
          this.hooks.lifecycle.processResource.call(
            appInfo,
            manager,
            resources,
          );
          appInstance = new App(
            this,
            appInfo,
            manager,
            resources,
            isHtmlMode,
            this.options.customLoader,
          );
          this.cacheApps[appName] = appInstance;
        } catch (e) {
          __DEV__ && error(e);
          this.hooks.lifecycle.errorLoadApp.call(appInfo, e);
        } finally {
          this.loading[appName] = null;
        }
      }
      this.hooks.lifecycle.afterLoad.call(appInfo, appInstance);
      return appInstance;
    };

    if (!options.cache || !this.loading[appName]) {
      this.loading[appName] = asyncLoadProcess();
    }
    return this.loading[appName];
  }

  // async loadComponent(
  //   name: string,
  //   options: interfaces.LoadComponentOptions,
  // ): Promise<interfaces.Component> {
  //   const opts: interfaces.LoadComponentOptions = {
  //     ...defaultLoadComponentOptions,
  //     ...options,
  //   };
  //   const nameWithVersion = opts?.version ? `${name}@${opts?.version}` : name;
  //   const asyncLoadProcess = async () => {
  //     // Existing cache caching logic
  //     let result = null;
  //     const cacheComponents = this.cacheComponents[nameWithVersion];
  //     if (opts.cache && cacheComponents) {
  //       result = cacheComponents;
  //     } else {
  //       const manager = (await this.loader.load(
  //         opts?.url,
  //       )) as interfaces.JsResource;
  //       try {
  //         result = new Component(this, { name, ...opts }, manager);
  //         this.cacheComponents[nameWithVersion] = result;
  //       } catch (e) {
  //         __DEV__ && error(e);
  //       } finally {
  //         this.loading[nameWithVersion] = null;
  //       }
  //     }
  //     return result;
  //   };

  //   if (!opts.cache || !this.loading[nameWithVersion]) {
  //     this.loading[nameWithVersion] = asyncLoadProcess();
  //   }
  //   return this.loading[nameWithVersion];
  // }
}
