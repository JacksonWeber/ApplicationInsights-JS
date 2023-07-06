/**
* CfgSyncPlugin.ts
* @copyright Microsoft 2018
*/

import dynamicProto from "@microsoft/dynamicproto-js";
import { IConfig } from "@microsoft/applicationinsights-common";
import {
    BaseTelemetryPlugin, IAppInsightsCore, IConfigDefaults, IConfiguration, IPlugin, IProcessTelemetryContext,
    IProcessTelemetryUnloadContext, ITelemetryItem, ITelemetryPluginChain, ITelemetryUnloadState, createProcessTelemetryContext,
    createUniqueNamespace, eventOff, eventOn, getGlobal, getJSON, isFetchSupported, isXhrSupported, mergeEvtNamespace, onConfigChange,
    sendCustomEvent
} from "@microsoft/applicationinsights-core-js";
import { doAwaitResponse } from "@nevware21/ts-async";
import { ITimerHandler, isFunction, isNullOrUndefined, objDeepFreeze, scheduleTimeout } from "@nevware21/ts-utils";
import { ICfgSyncConfig, ICfgSyncEvent, NonOverrideCfg, OnCompleteCallback, SendGetFunction } from "./Interfaces/ICfgSyncConfig";
import { ICfgSyncPlugin } from "./Interfaces/ICfgSyncPlugin";
import { replaceByNonOverrideCfg } from "./CfgSyncHelperFuncs";

const evtName = "cfgsync";
const STR_GET_METHOD = "GET";
const FETCH_SPAN = 1800000; // 30 minutes
const udfVal: undefined = undefined;
let defaultNonOverrideCfg: NonOverrideCfg  = {instrumentationKey: true, connectionString: true, endpointUrl: true }
const _defaultConfig: IConfigDefaults<ICfgSyncConfig> = objDeepFreeze({
    disableAutoSync: false,
    customEvtName: udfVal,
    cfgUrl: udfVal, // as long as it is set to NOT NUll, we will NOT use config from core
    receiveChanges: false,
    overrideSyncFunc: udfVal,
    overrideFetchFunc: udfVal,
    onCfgChangeReceive: udfVal,
    scheduleFetchTimeout: FETCH_SPAN,
    nonOverrideConfigs: defaultNonOverrideCfg
});

export class CfgSyncPlugin extends BaseTelemetryPlugin implements ICfgSyncPlugin {

    public priority = 198;
    public identifier = "AppInsightsCfgSyncPlugin";

    constructor() {
        super();

        let _extensionConfig: ICfgSyncConfig;
        let _mainConfig: IConfiguration & IConfig; // throttle config should be wrapped in IConfiguration
        let _isAutoSync: boolean;
        let _evtName: string;
        let _evtNamespace: string | string[];
        let _cfgUrl: string;
        let _timeoutHandle: ITimerHandler;
        let _receiveChanges: boolean; // if it is set true, it won't send out any events
        let _fetchSpan: number;
        let _onCfgChangeReceive: (event: ICfgSyncEvent) => void;
        let _nonOverrideConfigs: NonOverrideCfg;
        let _fetchFn: SendGetFunction;
        let _overrideFetchFn: SendGetFunction;
        let _overrideSyncFn: (config?:IConfiguration & IConfig, customDetails?: any) => boolean;

        dynamicProto(CfgSyncPlugin, this, (_self, _base) => {

            _initDefaults();

            _self.initialize = (config: IConfiguration & IConfig, core: IAppInsightsCore, extensions: IPlugin[], pluginChain?:ITelemetryPluginChain) => {
                _base.initialize(config, core, extensions, pluginChain);
                _evtNamespace = mergeEvtNamespace(createUniqueNamespace(_self.identifier), core.evtNamespace && core.evtNamespace());
                _populateDefaults(config);
            };

            // used for V2 to manaully trigger config udpate
            _self.setCfg = (config?: IConfiguration & IConfig) => {
                return _setCfg(config, _isAutoSync);
            }

            // to allow manually sync config or other events
            _self.sync = (customDetails?: any) => {
                return _sendCfgsyncEvents(customDetails);
            }

            _self.updateEventListenerName = (eventName?: string) => {
                return _updateEventListenerName(eventName);
            }

            _self._doTeardown = (unloadCtx?: IProcessTelemetryUnloadContext, unloadState?: ITelemetryUnloadState) => {
                _eventOff();
                _clearScheduledTimer();
                _initDefaults();
            };

            _self["_getDbgPlgTargets"] = () => {
                return [_isAutoSync, _receiveChanges, _evtName, _mainConfig];
            };
    
            function _initDefaults() {
                _mainConfig = null;
                _isAutoSync = null;
                _evtName = null;
                _evtNamespace = null;
                _cfgUrl = null;
                _receiveChanges = null;
                _nonOverrideConfigs = null;
                _timeoutHandle = null;
                _fetchSpan = null;
                _overrideFetchFn = null;
                _overrideSyncFn = null;
                _onCfgChangeReceive = null;
            }

            // for v3
            function _populateDefaults(config: IConfiguration) {
                let identifier = _self.identifier;
                let core = _self.core;
               
                _self._addHook(onConfigChange(config, () => {
                    let ctx = createProcessTelemetryContext(null, config, core);
                    _extensionConfig = ctx.getExtCfg(identifier, _defaultConfig);
                    if (isNullOrUndefined(_isAutoSync)) {
                        _isAutoSync = !_extensionConfig.disableAutoSync;
                    }
                    if (isNullOrUndefined(_receiveChanges)) {
                        _receiveChanges = !!_extensionConfig.receiveChanges;
                    }
                   
                    let _newEvtName =  _extensionConfig.customEvtName || evtName;
                    if (_evtName !== _newEvtName) {
                        if (_receiveChanges) {
                            _updateEventListenerName(_newEvtName);

                        } else {
                            _eventOff();
                            _evtName = _newEvtName;
                        }
                        
                    }

                    if (isNullOrUndefined(_cfgUrl)) {
                        _cfgUrl = _extensionConfig.cfgUrl;
                    }
                    // if cfgUrl is set, we will ignore core config change
                    if (!_cfgUrl) {
                        _mainConfig = config;  // might not need this core.config
                        if (_isAutoSync) {
                            _sendCfgsyncEvents();
                        }
                    }
                }));
               
                _overrideSyncFn = _extensionConfig.overrideSyncFn;
                _overrideFetchFn = _extensionConfig.overrideFetchFn;
                _onCfgChangeReceive = _extensionConfig.onCfgChangeReceive;
                _nonOverrideConfigs = _extensionConfig.nonOverrideConfigs;
                _fetchSpan = _extensionConfig.scheduleFetchTimeout;
                
                // NOT support cfgURL change to avoid mutiple fetch calls
                if (_cfgUrl) {
                    _fetchFn = _getFetchFnInterface();
                    _fetchFn && _fetchFn(_cfgUrl, _onFetchComplete, _isAutoSync);
                    _setupTimer();
                }
            }

            function _setCfg(config?: IConfiguration & IConfig, isAutoSync?: boolean) {
                if (config) {
                    _mainConfig = config;
                    if (!!isAutoSync) {
                        return _sendCfgsyncEvents();
                    }
                }
                return false;
            }

            function _eventOff() {
                try {
                    let global = getGlobal();
                    if (global) {
                        eventOff(global, null, null,  _evtNamespace);
                    }
                } catch (e) {
                    // eslint-disable-next-line no-empty
                }
            }

            function _sendCfgsyncEvents(customDetails?: any) {
                try {
                    if (!!_overrideSyncFn && isFunction(_overrideSyncFn)) {
                        return _overrideSyncFn(_mainConfig, customDetails);
                    }
                    return sendCustomEvent(_evtName, _mainConfig, customDetails);

                } catch (e) {
                    // eslint-disable-next-line no-empty
                }
                return false;
            }

            function _updateEventListenerName(name?: string) {
                try {
                    _eventOff();
                    if (name) {
                        _evtName = name;
                        _addEventListener();
                    }
                    return true;
                } catch (e) {
                    // eslint-disable-next-line no-empty
                }
                return false;
            }


            function _getFetchFnInterface() {
                let _fetchFn = _overrideFetchFn;
                if (isNullOrUndefined(_fetchFn)) {
                    if (isFetchSupported()) {
                        _fetchFn = _fetchSender;
                    } else if (isXhrSupported()) {
                        _fetchFn = _xhrSender;
                    }
                }
                return _fetchFn;
            }


            function _fetchSender(url: string, oncomplete: OnCompleteCallback, isAutoSync?:  boolean) {
                let global = getGlobal();
                let fetchFn = (global && global.fetch) || null;
                if (url && fetchFn && isFunction(fetchFn)) {
                    try {
                        const init: RequestInit = {
                            method: STR_GET_METHOD
                        };
                        const request = new Request(url, init);
                        doAwaitResponse(fetch(request), (result) => {
                            if (!result.rejected) {
                                let response = result.value;
                                if (response.ok) {
                                    doAwaitResponse(response.text(), (res) => {
                                        _doOnComplete(oncomplete, response.status, res.value, isAutoSync);
                                    });
                                }
                            }
                        });
                    } catch (e) {
                        // eslint-disable-next-line no-empty
                    }
                }
            }

            function _xhrSender(url: string, oncomplete: OnCompleteCallback, isAutoSync?: boolean) {
                try {
                    let xhr = new XMLHttpRequest();
                    xhr.open(STR_GET_METHOD, url);
                    xhr.onreadystatechange = () => {
                        if (xhr.readyState === XMLHttpRequest.DONE) {
                            _doOnComplete(oncomplete, xhr.status, xhr.responseText, isAutoSync);
                        }
                    }
                    xhr.send();
                } catch (e) {
                    // eslint-disable-next-line no-empty
                }
            }

            function _onFetchComplete(status: number, response?: string, isAutoSync?: boolean) {
                if (status >= 200 && status < 400 && response) {
                    try {
                        let JSON = getJSON();
                        if (JSON) {
                            let cfg = JSON.parse(response); //comments are not allowed
                            cfg && _setCfg(cfg, isAutoSync);
                        }
                    } catch (e) {
                        // eslint-disable-next-line no-empty
                    }
                    
                }
            }

            function _doOnComplete(oncomplete: OnCompleteCallback, status: number, response?: string, isAutoSync?: boolean) {
                try {
                    oncomplete(status, response, isAutoSync);
                } catch (e) {
                    // eslint-disable-next-line no-empty
                }
            }

            function _addEventListener() {
                if (_receiveChanges) {
                    let global = getGlobal();
                    if (global) {
                        try {
                            eventOn(global, _evtName, (event: any) => {
                                let cfgEvent = event && (event as any).detail;
                                if (_onCfgChangeReceive && cfgEvent) {
                                    _onCfgChangeReceive(cfgEvent);
                                } else {
                                    let cfg = cfgEvent && cfgEvent.cfg;
                                    let newCfg = cfg && _replaceTartgetByKeys(cfg);
                                    newCfg && _self.core.updateCfg(newCfg);
                                }
                            }, _evtNamespace, true);

                        } catch(e) {
                            // eslint-disable-next-line no-empty
                        }
                    }
                }
            }
            // 4 levels
            function _replaceTartgetByKeys<T=IConfiguration & IConfig>(cfg: T , level?: number) {
                let _cfg: IConfiguration & IConfig = null;
                try {
                    if (_nonOverrideConfigs && cfg) {
                        _cfg = replaceByNonOverrideCfg(cfg, _nonOverrideConfigs, 1, 5);
                    }
                } catch(e) {
                    // eslint-disable-next-line no-empty
                }
                return _cfg;
            }

            /**
             * Sets up the timer which triggers actually fetching cdn every 30mins after inital call
             */
            function _setupTimer() {
                if (!_timeoutHandle && _fetchSpan) {
                    _timeoutHandle = scheduleTimeout(() => {
                        _timeoutHandle = null;
                        _fetchFn(_cfgUrl, _onFetchComplete, _isAutoSync);
                        _setupTimer();
                    }, _fetchSpan);
                }
            }

            function _clearScheduledTimer() {
                _timeoutHandle && _timeoutHandle.cancel();
                _timeoutHandle = null;
            }
        

            _self.processTelemetry = (env: ITelemetryItem, itemCtx?: IProcessTelemetryContext) => {
                _self.processNext(env, itemCtx);
            };

        });
    }

    public initialize(config: IConfiguration & IConfig, core: IAppInsightsCore, extensions: IPlugin[], pluginChain?:ITelemetryPluginChain) {
        // @DynamicProtoStub -- DO NOT add any code as this will be removed during packaging
    }

    public setCfg(config?: IConfiguration & IConfig): boolean {
        // @DynamicProtoStub -- DO NOT add any code as this will be removed during packaging
        return null;
    }

    public sync(customDetails?: any): boolean {
        // @DynamicProtoStub -- DO NOT add any code as this will be removed during packaging
        return null;
    }

    public updateEventListenerName(eventName?: string): boolean {
        // @DynamicProtoStub -- DO NOT add any code as this will be removed during packaging
        return null;
    }
   
    // /**
    //  * Add Part A fields to the event
    //  * @param event - The event that needs to be processed
    //  */
    public processTelemetry(event: ITelemetryItem, itemCtx?: IProcessTelemetryContext) {
        // @DynamicProtoStub -- DO NOT add any code as this will be removed during packaging
    }
}
