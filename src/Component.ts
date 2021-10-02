/*eslint no-underscore-dangle: "off", react/no-is-mounted: "off" */

import globals, {now, DEBUG, DEBUG_REBACK, PROFILE_REBACK, TESTING} from './globals';

import {getLogger} from 'logger-js';

import SyncPromise from 'sync-promise-js';

import PromiseChain from './PromiseChain';
import RenderPending from './RenderPending';
import {sameShallow, applyModificationsCached, compareMaps, d} from './util';
import {start as startTiming, end as stopTiming} from './profiling';
import Cache from './Cache';
import HashCache from './HashCache';
import emptyContext from './EmptyContext';
import {addUsedContextAttributes, anyUsedAttribute} from './Context';
import SingleEntryCache from './SingleEntryCache';

import type Context from './Context';

const logger = getLogger('reback');

/**
 * ID for a scheduled task, which could be regular timeout or a requested animation frame (or both, theoretically).
 * This ID can be used to cancel the task.
 * A value of 0 in either slot means that the respective type of scheduling has not been used.
 */
type ScheduleID = [ReturnType<typeof setTimeout> | 0, ReturnType<typeof requestAnimationFrame> | 0];

/**
 * Time (in milliseconds) to wait before firing a render request on a root component.
 * Subsequent render requests in that time frame will be batched, and only a single request will ultimately
 * be fired.
 * A value of -1 means to wait for the next animation frame if the page is visible,
 * or use a timeout of 100 ms if the page is hidden.
 */
const RENDER_BATCH_TIME = -1;

const EMPTY_SET: ReadonlySet<any> = new Set();

const Phase = {
    CREATING: 0,
    MOUNTING: 1,
    PREPARING: 2,
    RENDERING: 3,
    RENDERED: 4,
    UNMOUNTING: 5,
    RESTORING: 6
};
const PHASE_NAMES = {};
Object.keys(Phase).forEach(name => {
    const value = Phase[name];
    PHASE_NAMES[value] = name;
});
const BITS_PHASE = 3;
const MASK_PHASE = 0b111;

const FLAGS_OFFSET = BITS_PHASE;
const FLAG_MOUNTED = 1 << FLAGS_OFFSET;
const FLAG_PREPARED = 1 << (FLAGS_OFFSET + 1);
const FLAG_KEPT_MOUNTED = 1 << (FLAGS_OFFSET + 2);
const FLAG_AVOID_RENDER_AFTER_RENDER = 1 << (FLAGS_OFFSET + 3);
const FLAG_NEEDS_RENDER_AFTER_RENDER = 1 << (FLAGS_OFFSET + 4);
const FLAG_NEEDS_PREPARE_AFTER_PREPARE = 1 << (FLAGS_OFFSET + 5);
const FLAG_ERROR_DURING_INITIALIZE = 1 << (FLAGS_OFFSET + 6);
const FLAG_RENDER_ROOT_WAS_INTERRUPTED = 1 << (FLAGS_OFFSET + 7);

function setPhaseFlags(flags: number, phase: number): number {
    return (flags & ~MASK_PHASE) | phase;
}

/**
 * Singleton object to indicate an interrupted render result.
 */
const RENDER_INTERRUPT = {};

let idCounter = 0;

export type AnyComponent = Component<any, any, any, any, any>;

type RenderStateSnapshot = any[];

/**
 * Stack of currently rendering components.
 * The root component is at `renderStack[0]`.
 * This stack cannot be accessed directly from other modules; they need to use
 * `getCurrentRenderRoot`, `getCurrentRenderParent`, `pushToRenderStack`, and `popFromRenderStack`
 * instead.
 */
let renderStack: AnyComponent[] = [];
let renderStackData: AnyInternalData[] = [];

const renderState = {
    /**
     * Whether a render pass is currently happening.
     */
    isRendering: false,

    /**
     * Whether the current render pass has been interrupted.
     */
    isRenderInterrupted: false,

    /**
     * Whether the previous render pass was interrupted.
     */
    lastRenderWasInterrupted: false,

    /**
     * Number of non-interrupted components rendered in the previous render pass.
     */
    lastRenderComponentCount: 0,

    /**
     * Start time of this render pass (in milliseconds after some epoch).
     * Only differences of times are really meaningful.
     */
    renderStartTime: 0,

    /**
     * Number of interrupted render passes before this render pass.
     */
    renderInterruptGeneration: 0,

    /**
     * Number of non-interrupted components rendered in this render pass.
     */
    renderComponentCount: 0
};

function getCurrentRenderRoot(): AnyComponent | null {
    if (renderStack.length) {
        return renderStack[0];
    } else {
        return null;
    }
}

function getCurrentRenderRootData(): AnyInternalData | null {
    if (renderStackData.length) {
        return renderStackData[0];
    } else {
        return null;
    }
}

function getCurrentRenderParent(): AnyComponent | null {
    if (renderStack.length) {
        return renderStack[renderStack.length - 1];
    } else {
        return null;
    }
}

function getCurrentRenderParentData(): AnyInternalData | null {
    if (renderStackData.length) {
        return renderStackData[renderStackData.length - 1];
    } else {
        return null;
    }
}

function pushToRenderStack(component: AnyComponent, data: AnyInternalData): void {
    renderStack.push(component);
    renderStackData.push(data);
}

function popFromRenderStack(): void {
    renderStack.pop();
    renderStackData.pop();
}

/**
 * Resets the render state for rendering a new root component.
 * Returns a data structure that can be used to restore the old state,
 * when rendering of the new root component is finished.
 * This includes data for the current render stack, even though it's technically
 * not part of the `renderState`.
 */
function resetState(): RenderStateSnapshot {
    const oldState = [
        renderState.isRendering,
        renderState.isRenderInterrupted,
        renderState.lastRenderWasInterrupted,
        renderState.lastRenderComponentCount,
        renderState.renderStartTime,
        renderState.renderInterruptGeneration,
        renderState.renderComponentCount,
        renderStack.slice(0),
        renderStackData.slice(0)
    ];
    renderState.isRendering = false;
    renderState.isRenderInterrupted = false;
    renderState.lastRenderWasInterrupted = false;
    renderState.lastRenderComponentCount = 0;
    renderState.renderComponentCount = 0;
    renderStack = [];
    renderStackData = [];
    return oldState;
}

/**
 * Restores a previous render state.
 */
function restoreState(oldState: RenderStateSnapshot): void {
    renderState.isRendering = oldState[0];
    renderState.isRenderInterrupted = oldState[1];
    renderState.lastRenderWasInterrupted = oldState[2];
    renderState.lastRenderComponentCount = oldState[3];
    renderState.renderStartTime = oldState[4];
    renderState.renderInterruptGeneration = oldState[5];
    renderState.renderComponentCount = oldState[6];
    renderStack = oldState[7];
    renderStackData = oldState[8];
}

function didContextChange(
    newContext?: Context | null,
    prevContext?: Context | null,
    usedAttributes?: Array<number>
): boolean {
    if (!newContext || !usedAttributes || newContext === prevContext) {
        return false;
    }
    const context = newContext;
    return anyUsedAttribute(usedAttributes, name => {
        return !prevContext || !context.sameValue(prevContext.attributes.get(name), context.attributes.get(name), name);
    });
}

type InterruptedItem = {root: AnyComponent; rootData: AnyInternalData; interrupted: AnyInternalData[]};

/**
 * Components that have been interrupted in the previous render pass,
 * as a map from root component IDs to an array of interrupted components.
 * After a little pause or on the next render pass of a root component (whichever comes first),
 * all corresponding components are re-rendered.
 * We choose a map so that we don't need a property on every single component
 * (even non-root components).
 */
const interruptedComponents: Map<ID, InterruptedItem> = new Map();

/**
 * Timeout for re-rendering previously interrupted components.
 */
let rerenderInterruptedTimeout: ScheduleID | null = null;

/**
 * Components that have been unmounted recently.
 */
const unmountedComponents: AnyComponent[] = [];

/**
 * Timeout for calling `onDisappear` on unmounted components.
 */
let disappearHandlersTimeout: ScheduleID | null = null;

export type RenderOptions<ContextType = Context> = {
    context?: ContextType;
    isRequired?: boolean;
    isOptional?: boolean;
};

type ID = number;

type CacheEntry<RenderResult> = {
    result: RenderResult;
    instance: AnyComponent;
    children: Map<ID, ChildInfo> | null;
    context: Context | null;
    usedContextAttributes: number[];
    descendantCount: number;
};

// Information for each child (stored on the parent) has the same structure as render cache entries,
// since we need to be able to restore `renderedChildren` from the render cache (and, vice-versa, we construct the
// child information in the render cache from `renderedChildren`).
type ChildInfo = CacheEntry<any>;
type Children = Map<number, ChildInfo>;

function iterChildren(children: Children, callback: (c: AnyComponent, id: ID) => void) {
    children.forEach((value, key) => {
        callback(value.instance, key);
    });
}

function allChildren(children: Children, callback: (instance: any, id: ID) => boolean) {
    for (const [key, value] of children) {
        if (!callback(value.instance, key)) {
            return false;
        }
    }
    return true;
}

type SchedulerFunc = (func: () => void, delay?: number) => ScheduleID;
type CancelScheduleFunc = (id: ScheduleID) => void;

let scheduler: SchedulerFunc = (func: () => void, delay = 0): ScheduleID => {
    if (delay === -1) {
        // If requestAnimationFrame is not available and during testing, fall back to setTimeout
        // (assuming ~60 fps).
        if (globals.requestAnimationFrame && !TESTING) {
            // If the page is hidden, requestAnimationFrame does not fire, so we use a timeout instead (see CLOUD-15123).
            // Browsers might also throttle timeouts for background windows, but it's okay
            // for background notebooks to load more slowly, as long as they load eventually.
            // See https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API#Policies_in_place_to_aid_background_page_performance
            // for more information.
            if (globals.document && globals.document.hidden) {
                return [setTimeout(func, 100), 0];
            } else {
                return [0, requestAnimationFrame(func)];
            }
        } else {
            return [setTimeout(func, 16), 0];
        }
    }
    return [setTimeout(func, delay), 0];
};

let cancelSchedule: CancelScheduleFunc = ([timeoutID, animationFrameID]: ScheduleID) => {
    if (timeoutID) {
        clearTimeout(timeoutID);
    }
    if (animationFrameID && globals.cancelAnimationFrame) {
        cancelAnimationFrame(animationFrameID);
    }
};

function _rerenderInterrupted(rootId: ID) {
    const item = interruptedComponents.get(rootId);
    if (item) {
        const interrupted = item.interrupted;
        for (let i = 0, l = interrupted.length; i < l; ++i) {
            let data: AnyInternalData | void = interrupted[i];
            let invalidatePrepare = false;
            while (data) {
                // We only invalidate the render cache here and don't call `forceRender`,
                // since that would bubble up to the root and schedule another render pass.
                // But we might already be in a render pass (this is called from `renderRoot`),
                // and then that would be unnecessary.
                if (invalidatePrepare) {
                    _invalidatePrepareCache(data);
                }
                _invalidateRenderCache(data);
                const phase = data.flags & MASK_PHASE;
                if (phase !== Phase.RENDERED && phase !== Phase.RESTORING) {
                    // If the component is currently mounting, preparing, or unmounting, it doesn't need to bubble
                    // up a cache invalidation (similarly to `forceRender`).
                    break;
                }
                _resetPendingRender(data);
                const parentData = data._renderParentData;
                invalidatePrepare =
                    (parentData && parentData.childrenData && parentData.childrenData.prepareChildren.has(data._id)) ||
                    false;
                data = parentData;
            }
        }
        interruptedComponents.delete(rootId);
    }
}

function rerenderAllInterrupted() {
    if (rerenderInterruptedTimeout) {
        cancelSchedule(rerenderInterruptedTimeout);
        rerenderInterruptedTimeout = null;
    }
    interruptedComponents.forEach((item, id) => {
        const {root, rootData} = item;
        _rerenderInterrupted(id);
        // In addition to invalidating all respective render caches,
        // we also schedule another render pass of the root component.
        _forceRender(root, rootData, false);
    });
}

function scheduleRerenderInterrupted() {
    if (!rerenderInterruptedTimeout) {
        rerenderInterruptedTimeout = scheduler(rerenderAllInterrupted, RENDER_BATCH_TIME);
    }
}

function scheduleDisappearHandlers() {
    if (!disappearHandlersTimeout) {
        disappearHandlersTimeout = scheduler(() => {
            disappearHandlersTimeout = null;
            for (let i = 0, l = unmountedComponents.length; i < l; ++i) {
                const component = unmountedComponents[i];
                // If the component is still not mounted on the next tick, trigger onDisappear.
                if (!component.isMounted()) {
                    component.onDisappear();
                }
            }
            unmountedComponents.length = 0;
        }, 0);
    }
}

function _childFinishedRender(thisData: AnyInternalData, childData: AnyInternalData, child: AnyComponent, result: any) {
    const id = childData._id;
    getChildrenData(thisData).renderedChildren.set(id, {
        result,
        instance: child,
        children: childData.childrenData ? new Map(childData.childrenData.renderedChildren) : null,
        context: childData._context,
        usedContextAttributes: childData._usedContextAttributes.slice(0),
        descendantCount: 0
    });
    addUsedContextAttributes(thisData._usedContextAttributes, childData._usedContextAttributes);
}

function _doRender<PrepareResult, RenderArgs, RenderResult>(
    data: AnyInternalData,
    that: AnyComponent,
    arg: RenderArgs
): RenderResult {
    const prepare = data._prepare;
    if (prepare && prepare.isPending()) {
        DEBUG_REBACK && logger.debug(d`Cannot render ${that} because preparation is still pending`);
        throw new RenderPending();
    }
    const methods = data.methods;
    const changedAttrs = data._changedAttributesSincePrepare;
    if (!(data.flags & FLAG_PREPARED) || methods.shouldPrepare.call(that, changedAttrs || EMPTY_SET)) {
        // Before running a fresh prepare, clear any used context attributes.
        // It is only safe to do this here (not before every render), since
        // context attributes might be used during prepare whose usage wouldn't be
        // restored if a previous prepare is reused.
        data._usedContextAttributes = [];
        if (changedAttrs) {
            changedAttrs.clear();
        }
        // Whenever we prepare a component, also invalidate its render cache.
        // This is important since `doPrepare` might create new child components that are supposed to be used in `doRender`,
        // and we don't want to use an old render cache that referenced old child components.
        _invalidateRenderCache(data);
        do {
            const error = _doPrepare(data, that);
            const {childrenData} = data;
            if (childrenData) {
                const pc = (childrenData.prepareChildren = new Map(childrenData.renderedChildren));
                iterChildren(pc, child => {
                    addUsedContextAttributes(data._usedContextAttributes, child._reback._usedContextAttributes);
                });
            }
            if (error) {
                throw error;
            }
        } while (data.flags & FLAG_NEEDS_PREPARE_AFTER_PREPARE);
    } else {
        const {childrenData} = data;
        if (childrenData) {
            childrenData.renderedChildren = new Map(childrenData.prepareChildren);
        }
    }
    const cached = data._renderCache.getEntry(arg);
    const prepareResult: PrepareResult = data._prepareResult as any;
    if (
        cached === Cache.MISSING ||
        didContextChange(data._context, cached.context, cached.usedContextAttributes) ||
        methods.shouldRender.call(that, arg, prepareResult)
    ) {
        data.flags = setPhaseFlags(data.flags, Phase.RENDERING);
        const previousCount = renderState.renderComponentCount;
        const renderResult: any = methods.doRender.call(that, arg, prepareResult);
        if (renderResult !== RENDER_INTERRUPT && !(data.flags & FLAG_NEEDS_RENDER_AFTER_RENDER)) {
            const descendantCount = renderState.renderComponentCount - previousCount;
            const cacheEntry: CacheEntry<RenderResult> = {
                result: renderResult,
                instance: that,
                children: data.childrenData ? new Map(data.childrenData.renderedChildren) : null,
                context: data._context,
                usedContextAttributes: data._usedContextAttributes.slice(0),
                descendantCount
            };
            data._renderCache.setEntry(arg, cacheEntry);
            data._currentlyUsedCache = cacheEntry;
        }
        return renderResult;
    } else {
        DEBUG_REBACK && logger.debug(d`Reusing render cache for ${that}`);
        _useCache(data, that, cached);
        renderState.renderComponentCount += cached.descendantCount;
        return cached.result;
    }
}

/**
 * Sets up the component to use a cached render result.
 */
function _useCache<RenderResult>(data: AnyInternalData, that: AnyComponent, cacheEntry: CacheEntry<RenderResult>) {
    DEBUG_REBACK && logger.debug(d`Using cache for ${that}`);
    const result = cacheEntry.result;
    const children = cacheEntry.children;
    const used = cacheEntry.usedContextAttributes;
    data._renderResult = result;
    if (children) {
        const childrenData = getChildrenData(data);
        childrenData.renderedChildren = children;
    } else {
        if (data.childrenData) {
            data.childrenData.renderedChildren = new Map();
        }
    }
    data._usedContextAttributes = used;
    const parentData = data._renderParentData;
    if (parentData) {
        addUsedContextAttributes(parentData._usedContextAttributes, used);
    }
    data.methods.onCachedRender.call(that, result);
    // If the cache entry is the one we've already been using, there's no need to recursively
    // update cached children. We know they are mounted correctly already.
    // (`_currentlyUsedCache` is reset when unmounting.)
    if (cacheEntry === data._currentlyUsedCache) {
        return;
    }
    data._currentlyUsedCache = cacheEntry;
    if (!children) {
        return;
    }
    DEBUG_REBACK && logger.debug(d`Using cache for children of ${that}`);
    for (const [_key, entry] of children) {
        const child = entry.instance;
        const childData = child._reback;
        if (childData._renderParent !== that) {
            DEBUG_REBACK &&
                logger.debug(d`Remounting cached child ${child} from ${childData._renderParent} to ${that}`);
            const wasMounted = !!(childData.flags & FLAG_MOUNTED);
            const prevParent = childData._renderParent;
            const newParent = that;
            childData._renderParent = that;
            childData._renderParentData = data;
            childData.flags = setPhaseFlags(childData.flags | FLAG_MOUNTED, Phase.RESTORING);
            _remount(child, childData, wasMounted, prevParent, newParent);
        }
        childData.flags = setPhaseFlags(childData.flags, Phase.RENDERED);
        DEBUG_REBACK && logger.beginBlock();
        _useCache(childData, child, entry);
        DEBUG_REBACK && logger.endBlock();
    }
}

function _doPrepare(data: AnyInternalData, that: AnyComponent): Error | null {
    DEBUG_REBACK && logger.debug(d`Preparing ${that}`);
    data.flags = setPhaseFlags(data.flags & ~FLAG_PREPARED & ~FLAG_NEEDS_PREPARE_AFTER_PREPARE, Phase.PREPARING);
    let prepare = null;
    let [success, result] = tryCatch0(data.methods.doPrepare, that);
    if (result instanceof SyncPromise) {
        if (result.isFulfilled()) {
            result = result.getValueSync();
        } else if (result.isRejected()) {
            success = false;
            result = result.getExceptionSync();
        }
    }
    if (!success) {
        // Throw an error immediately. We don't want to keep on rendering if preparation fails synchronously.
        DEBUG_REBACK && logger.debug(d`Re-throwing error ${result} during preparation of ${that}`);
        data._prepare = null;
        return result;
    }
    const then = result ? result.then : null;
    if (typeof then === 'function') {
        prepare = data._prepare = then.call(
            result,
            value => {
                DEBUG_REBACK && logger.debug(d`Preparation of ${that} resolved`);
                // Only actually set the prepare result when this is still the "current" preparation.
                // E.g. if `.forceRender()` is called while this preparation is pending,
                // the prepare result should be ignored.
                // Note that `prepare` might still be undefined when this is running synchronously.
                // In that case do not ignore the result.
                if (!prepare || data._prepare === prepare) {
                    data.flags |= FLAG_PREPARED;
                    data._prepareResult = value;
                    data._prepare = null;
                    DEBUG_REBACK && logger.debug(d`Rendering ${that} because preparation resolved`);
                    _forceRender(that, data, false);
                } else {
                    DEBUG_REBACK && logger.debug(d`Ignoring preparation ${prepare} of ${that}`);
                }
            },
            error => {
                DEBUG_REBACK && logger.debug(d`Preparation of ${that} threw an asynchronous error: ${error}`);
                _forceRender(that, data, false);
                if (!(error instanceof RenderPending)) {
                    // Do not "persist" RenderPending errors.
                    // Just re-render when a RenderPending is thrown asynchronously.
                    // Do this after calling _forceRender, since that resets _renderError.
                    getUncommonData(data).renderError = error;
                }
            }
        );
        DEBUG_REBACK && logger.debug(d`Throw RenderPending in preparation of ${that}`);
        if (DEBUG_REBACK) {
            return new RenderPending({duringPrepareOf: that});
        }
        return new RenderPending();
    } else {
        data.flags |= FLAG_PREPARED;
        data._prepareResult = result;
        data._prepare = null;
    }
    return null;
}

function _performRender(
    data: AnyInternalData,
    arg: any,
    error: any,
    isRequired: boolean,
    isOptional: boolean,
    keepExistingChildren: boolean,
    that: AnyComponent
): [boolean, any, any] {
    const methods = data.methods;
    const childrenData = data.childrenData;
    const prevChildren = childrenData ? childrenData.renderedChildren : null;
    if (!keepExistingChildren) {
        if (childrenData) {
            childrenData.renderedChildren = new Map();
        }
    }
    pushToRenderStack(that, data);
    data.flags = setPhaseFlags(data.flags, Phase.RENDERING);
    let isPending = false;
    let renderResult;
    let renderError;

    // If this current render pass has been interrupted by a previous component, or
    // if the previous render pass was not interrupted, or
    // if we're already past the point where the previous render pass was interrupted,
    // AND if this component asks for an interrupt,
    // then interrupt rendering, which renders the component in a pending state (for now) and schedules it
    // for re-rendering in the next render pass.
    const newComponents = renderState.renderComponentCount - renderState.lastRenderComponentCount;
    const mayInterrupt = renderState.isRenderInterrupted || !renderState.lastRenderWasInterrupted || newComponents > 0;
    let shouldInterrupt;
    if (mayInterrupt) {
        const time = now() - renderState.renderStartTime;
        shouldInterrupt = methods.shouldInterruptRender.call(
            that,
            renderState.renderInterruptGeneration,
            time,
            newComponents
        );
    } else {
        shouldInterrupt = false;
    }
    if (shouldInterrupt && !renderState.isRenderInterrupted) {
        renderState.isRenderInterrupted = true;
        ++renderState.renderInterruptGeneration;
    }
    let success = true;
    let resultOrException;
    if (shouldInterrupt) {
        resultOrException = RENDER_INTERRUPT;
    } else {
        try {
            if (error) {
                resultOrException = methods.doRenderError.call(that, arg, error);
            } else {
                resultOrException = _doRender(data, that, arg);
            }
        } catch (err) {
            success = false;
            resultOrException = err;
        }
    }
    const isInterrupted = resultOrException === RENDER_INTERRUPT;
    if (isInterrupted) {
        if (DEBUG_REBACK) {
            getRenderAnalysisData(data).isInterrupted = true;
        }
        const root = getCurrentRenderRoot();
        const rootData = getCurrentRenderRootData();
        if (root && rootData) {
            const id = rootData._id;
            let item: InterruptedItem | void = interruptedComponents.get(id);
            if (!item) {
                item = {root, rootData, interrupted: []};
                interruptedComponents.set(id, item);
            }
            const interrupted = item.interrupted;
            interrupted.push(data);
            scheduleRerenderInterrupted();
        }
    }
    const parentData = data._renderParentData;
    if (success && !isInterrupted) {
        renderResult = resultOrException;
        const pending = data._pendingCompleteRender;
        if (pending) {
            DEBUG_REBACK && logger.debug(d`Resolving complete render for component ${that}`);
            data._pendingCompleteRender = null;
            pending.dangerouslyResolve();
        }
        if (DEBUG_REBACK) {
            getRenderAnalysisData(data).success = true;
        }
    } else if (isInterrupted || resultOrException instanceof RenderPending) {
        // Throw away the previous result (that contains pending children),
        // but do not unmount those children.
        if (prevChildren) {
            const newChildrenData = getChildrenData(data);
            for (const [key, value] of prevChildren) {
                newChildrenData.renderedChildren.set(key, value);
            }
        }
        if (DEBUG_REBACK) {
            if (!isInterrupted) {
                getRenderAnalysisData(data).renderPendingThrown = resultOrException;
            }
        }
        if (isRequired || (parentData && !isOptional && parentData.methods.shouldWaitForChildren.call(that))) {
            DEBUG_REBACK && logger.debug(d`Required component ${that} is not ready yet`);
            if (DEBUG_REBACK) {
                getRenderAnalysisData(data).requiredButNotReady = true;
            }
            isPending = true;
        } else {
            DEBUG_REBACK && logger.debug(d`Render pending ${that} because RenderPending was thrown`);
            if (DEBUG_REBACK) {
                getRenderAnalysisData(data).renderPending = true;
            }
            renderResult = methods.doRenderPending.call(that, arg);
        }
    } else {
        renderError = resultOrException;
        if (DEBUG_REBACK) {
            getRenderAnalysisData(data).renderError = renderError;
        }
    }
    popFromRenderStack();
    if (!keepExistingChildren) {
        PROFILE_REBACK && startTiming('_unmountPreviousChildren');
        const newChildrenData = data.childrenData;
        if (prevChildren) {
            _unmountPreviousChildren(
                prevChildren,
                newChildrenData ? newChildrenData.renderedChildren : null,
                data,
                that
            );
        }
        PROFILE_REBACK && stopTiming('_unmountPreviousChildren');
    }
    if (parentData) {
        _childFinishedRender(parentData, data, that, renderResult);
    }
    return [isPending, renderResult, renderError];
}

function _unmountPreviousChildren(
    prevChildren: Children,
    nextChildren: Children | null,
    data: AnyInternalData,
    that: AnyComponent
) {
    iterChildren(prevChildren, (child, id) => {
        if (!nextChildren || !nextChildren.has(id)) {
            DEBUG_REBACK &&
                logger.debug(d`Unmounting ${child} from ${that} because it disappeared from its render tree`);
            _unmountFromParent(child, child._reback, that);
        }
    });
}

function _unmountFromParent(that: AnyComponent, data: AnyInternalData, parent: AnyComponent | null) {
    /*
        Consider the situation where a descendant C is moved (where A is `that`):

            A
            +-- B
            +-- C
        ~>
            A
            +-- B
                +-- C

        The only place C can move during A's render pass is to somewhere else in A's hierarchy.
        At the end of A's render pass, if C is mounted into a different parent than A,
        it shall not actually be unmounted.
     */
    const isMountedIntoAnotherParent = data._renderParent !== parent;
    if (!isMountedIntoAnotherParent) {
        DEBUG_REBACK && logger.debug(d`Unmounting children of ${that}`);
        DEBUG_REBACK && logger.beginBlock();
        const childrenData = data.childrenData;
        if (childrenData) {
            iterChildren(childrenData.renderedChildren, child => {
                _unmountFromParent(child, child._reback, that);
            });
        }
        DEBUG_REBACK && logger.debug(d`Unmounting ${that}`);
        data.flags = setPhaseFlags(data.flags, Phase.UNMOUNTING);
        // We need to invalidate the prepare cache since, otherwise, a component that is unmounted and later mounted again
        // wouldn't run `doPrepare` again, leaving its prepare-phase children still unmounted.
        // See https://stash.wolfram.com/projects/CLOUD/repos/cloudplatform/pull-requests/10218/overview?commentId=523159 and related discussion.
        _invalidatePrepareCache(data);
        // We need to invalidate the whole render cache as soon as the component unmounts.
        // While the component is unmounted, some cache-invalidating events (such as changed attributes)
        // don't propagate up the render tree (since unmounted components have no parent),
        // so when they remount any cached render result might not be valid anymore.
        // This resolves CLOUD-10762.
        _invalidateRenderCache(data);
        DEBUG_REBACK && logger.debug(d`Calling onUnmount of ${that}`);
        if (!(data.flags & FLAG_ERROR_DURING_INITIALIZE)) {
            data.methods.onUnmount.call(that);
        }
        data.flags &= ~FLAG_MOUNTED;
        data._renderParent = null;
        data._renderParentData = null;
        // Note that we don't reset the `_renderResult` here.
        // Even if a component is unmounted, it is useful to remember the last render result,
        // so that when it is remounted and pending, we have at least *something* to show temporarily.
        if (!(data.flags & FLAG_ERROR_DURING_INITIALIZE)) {
            unmountedComponents.push(that);
            scheduleDisappearHandlers();
        }
        DEBUG_REBACK && logger.endBlock();
    }
}

function _resetPendingRender(data: AnyInternalData) {
    if (!data._pendingRender) {
        data._pendingRender = new SyncPromise();
    }
    if (!data._pendingCompleteRender) {
        data._pendingCompleteRender = new SyncPromise();
    }
}

function _requestRender(that: AnyComponent, data: AnyInternalData) {
    const parent = data._renderParent;
    const parentData = data._renderParentData;
    if (parent && parentData) {
        DEBUG_REBACK && logger.debug(d`Triggering needs-render on ${that}`);
        const childrenData = parentData.childrenData;
        if (childrenData && childrenData.prepareChildren.has(data._id)) {
            _forcePrepare(parent, parentData);
        } else {
            _forceRender(parent, parentData, false);
        }
    } else {
        const rootData = getRootData(data);
        DEBUG_REBACK && logger.debug(d`Existing timeout: ${rootData.needsRenderTimeout}`);
        if (!rootData.needsRenderTimeout) {
            DEBUG_REBACK && logger.debug(d`Scheduling needs-render for ${that}`);
            rootData.needsRenderTimeout = scheduler(() => {
                rootData.needsRenderTimeout = null;
                DEBUG_REBACK && logger.debug(d`Triggering batched needs-render on ${that}`);
                const onRequestRender = getRootData(data).onRequestRender;
                if (onRequestRender) {
                    onRequestRender();
                }
            }, RENDER_BATCH_TIME);
        }
    }
}

function _enterRender(that: AnyComponent, data: AnyInternalData, context?: Context | null | void) {
    PROFILE_REBACK && startTiming('_enterRender');
    data.flags = setPhaseFlags(data.flags & ~FLAG_KEPT_MOUNTED, Phase.MOUNTING);
    const pending = data._pendingRender;
    if (pending) {
        data._pendingRender = null;
        pending.dangerouslyResolve();
    }
    const prevParent = data._renderParent;
    const newParent = getCurrentRenderParent();
    const wasMounted = !!(data.flags & FLAG_MOUNTED);
    data.flags |= FLAG_MOUNTED;
    data._renderParent = newParent;
    data._renderParentData = getCurrentRenderParentData();
    if (DEBUG_REBACK) {
        const renderPassStartTime = renderState.renderStartTime;
        if (newParent !== prevParent) {
            // We use the render pass start time to identify a render pass here. That should be fine since the
            // resolution of the timestamps is very granular. (But even if there's a collision -- two separate
            // render passes with the same start time -- it wouldn't be the end of the world, you might just get
            // unnecessary warnings when DEBUG_REBACK is on.)
            if (renderPassStartTime === data.debugRenderParentRenderPassStart) {
                logger.warn(d`Remounting component ${that} from ${prevParent} to ${newParent} \
during the same render pass. This is probably a bug in your code that will cause problems. \
A component should only be mounted into a single parent.`);
            }
            if (newParent === that) {
                logger.warn(d`Mounting component ${that} into itself. This will cause problems.`);
            }
        }
        data.debugRenderParentRenderPassStart = renderPassStartTime;
    }
    data.flags &= ~FLAG_NEEDS_RENDER_AFTER_RENDER;
    // This component is only added to `renderedChildren` of the parent when it is finished rendering.
    // If the parent changed or if this is the root component and wasn't mounted before,
    // then it is (re-) mounted.
    if (newParent !== prevParent || (!newParent && !wasMounted)) {
        DEBUG_REBACK && logger.debug(d`Remounting ${that} from ${prevParent} to ${newParent}`);
        _remount(that, data, wasMounted, prevParent, newParent, context);
    } else {
        _updateContext(that, data, newParent, context);
    }
    PROFILE_REBACK && stopTiming('_enterRender');
}

function _remount(
    that: AnyComponent,
    data: AnyInternalData,
    wasMounted: boolean,
    prevParent: AnyComponent | null,
    newParent: AnyComponent | null,
    context?: Context | null | void
) {
    if (wasMounted) {
        _unmountFromParent(that, data, prevParent);
    }
    // Update the context before running onAppear and onMount.
    _updateContext(that, data, newParent, context);
    if (!(data.flags & FLAG_ERROR_DURING_INITIALIZE)) {
        const methods = data.methods;
        // If this component didn't have a parent before, it's mounted for the first time.
        if (!wasMounted) {
            methods.onAppear.call(that);
        }
        methods.onMount.call(that);
    }
}

function _updateContext(
    that: AnyComponent,
    data: AnyInternalData,
    parent?: AnyComponent | null,
    givenContext?: Context | null | void
) {
    DEBUG_REBACK && logger.debug(d`Determining context for ${that} with parent ${parent}`);
    PROFILE_REBACK && startTiming('_updateContext');
    const prevContext = data._context;
    const context = givenContext || (parent ? parent.getModifiedContext() : emptyContext);
    PROFILE_REBACK && stopTiming('_updateContext');
    if (context !== prevContext) {
        if (DEBUG_REBACK && context.attributes && prevContext && prevContext.attributes) {
            const cmp = compareMaps(prevContext.attributes, context.attributes);
            logger.debug(`Context comparison: ${JSON.stringify(cmp)}`);
        }
        data._context = context;
        data._boundContext = null;
        if (didContextChange(context, prevContext, data._usedContextAttributes)) {
            _invalidatePrepareCache(data);
            _invalidateRenderCache(data);
        }
        DEBUG_REBACK && logger.debug(d`Context for ${that} changed`);
        if (!(data.flags & FLAG_ERROR_DURING_INITIALIZE)) {
            data.methods.onReceiveContext.call(that, prevContext);
        }
    }
}

/**
 * Returns a context object "bound" to the component instance,
 * keeping track of what context attributes are accessed per instance.
 * @param data Internal component data.
 */
function _getBoundContext<ContextType extends Context>(
    data: RebackInternalData<any, any, any, ContextType>
): ContextType | null {
    const context = data._context;
    if (context) {
        let boundContext = data._boundContext;
        if (boundContext) {
            return boundContext;
        }
        boundContext = context.changeComponent(data);
        data._boundContext = boundContext;
        return boundContext;
    } else {
        return null;
    }
}

function _walkTree(that: AnyComponent, data: AnyInternalData, callback: (descendant: AnyComponent) => void) {
    callback(that);
    const childrenData = data.childrenData;
    if (childrenData) {
        iterChildren(childrenData.renderedChildren, child => _walkTree(child, child._reback, callback));
    }
}

function _invalidatePrepareCache(data: AnyInternalData) {
    // Set a new promise for now. This is checked for in `_doPrepare`, and any result
    // from a pending preparation is subsequently ignored.
    DEBUG_REBACK && logger.debug(d`Invalidating prepare cache of ${data._id}`);
    data._prepare = null;
    data.flags &= ~FLAG_PREPARED;
    data._prepareResult = null;
    const childrenData = data.childrenData;
    if (childrenData) {
        childrenData.prepareChildren = new Map();
    }
}

function _invalidateRenderCache(data: AnyInternalData) {
    data._renderCache.empty();
    data._currentlyUsedCache = null;

    // E.g. when state changes, forget about a previous render error
    // -- unless the error happened during initialize.
    // This allows cells to "catch" dynamic update errors, change their state (forcedRenderMode),
    // and render again.
    if (!(data.flags & FLAG_ERROR_DURING_INITIALIZE)) {
        if (data.uncommonData) {
            data.uncommonData.renderError = null;
        }
    }
}

function _forceRender(that: AnyComponent, data: AnyInternalData, notDuringRender: boolean) {
    // Invalidate the render cache immediately, regardless of this component's phase.
    // This is important because the component might have been unmounted in the meanwhile, but the
    // next time it renders it still shouldn't reuse a previous render cache (cf. CLOUD-7731).
    _invalidateRenderCache(data);
    const phase = data.flags & MASK_PHASE;
    if (phase === Phase.RENDERING && !(data.flags & FLAG_AVOID_RENDER_AFTER_RENDER) && !notDuringRender) {
        DEBUG_REBACK && logger.info(d`Schedule render after rendering ${that}`);
        data.flags |= FLAG_NEEDS_RENDER_AFTER_RENDER;
        return;
    }
    // If this component is still about to render (i.e. its phase is before RENDERED) or it is already unmounting,
    // then it's safe to ignore the render request.
    if (phase !== Phase.RENDERED && phase !== Phase.RESTORING) {
        DEBUG_REBACK &&
            logger.debug(d`Ignoring render request for ${that} because it is in phase ${PHASE_NAMES[phase]}`);
        return;
    }
    DEBUG_REBACK && logger.debug(d`Forcing render of ${that}`);
    _resetPendingRender(data);
    _requestRender(that, data);
}

function _forcePrepare(that: AnyComponent, data: AnyInternalData) {
    const phase = data.flags & MASK_PHASE;
    if (phase === Phase.PREPARING) {
        DEBUG_REBACK && logger.info(d`Schedule prepare after preparing ${that}`);
        data.flags |= FLAG_NEEDS_PREPARE_AFTER_PREPARE;
        return;
    }
    // Ignore prepare requests when a render is underway, similarly to `forceRender`.
    if (phase !== Phase.RENDERED && phase !== Phase.RESTORING && phase !== Phase.RENDERING) {
        return;
    }
    _invalidatePrepareCache(data);
    _forceRender(that, data, false);
}

function _setState<State extends object, K extends keyof State>(
    that: AnyComponent,
    data: AnyInternalData,
    state: State,
    onChange: OnChange<State>,
    values: Pick<State, K>
) {
    let hasChanged = false;
    // Accumulate all state waiters that need to be resolved and resolve them at the end,
    // so that any other attributes updated in the same .setState call can be assumed to updated as well
    // by the time a state change fires.
    let allWaiters: Array<() => void> | null = null;
    for (const name in values) {
        if (values.hasOwnProperty(name)) {
            const value = values[name];
            const oldValue = state[name];
            if (oldValue !== value && !(Number.isNaN(oldValue) && Number.isNaN(value))) {
                state[name] = value as any;
                const changeListener = onChange && onChange[name];
                if (changeListener) {
                    changeListener.call(that, value, oldValue);
                }
                const phase = data.flags & MASK_PHASE;
                if (phase > Phase.MOUNTING) {
                    let changedAttrs = data._changedAttributesSincePrepare;
                    if (!changedAttrs) {
                        changedAttrs = data._changedAttributesSincePrepare = new Set();
                    }
                    changedAttrs.add(name);
                }
                const waiters = data.uncommonData ? data.uncommonData.stateWaiters[name] : null;
                if (waiters) {
                    for (let i = 0, l = waiters.length; i < l; ++i) {
                        const waiter = waiters[i];
                        if (waiter && value === waiter.value) {
                            if (!allWaiters) {
                                allWaiters = [];
                            }
                            allWaiters.push(waiter.resolve);
                            // TODO: We should clean up the waiters list at some point.
                            waiters[i] = null;
                        }
                    }
                }
                hasChanged = true;
            }
        }
    }
    if (hasChanged) {
        if (allWaiters) {
            for (let i = 0, l = allWaiters.length; i < l; ++i) {
                allWaiters[i]();
            }
        }
        if (DEBUG_REBACK) {
            logger.info(d`Rerendering ${that} due to changed attributes`);
        }
        // We really have to force a render here (i.e. also invalidate render caches), not only request it.
        // Otherwise only the next render pass would enter doRender, but subsequent passes after that might
        // still have a cache (e.g. the notebook would show the cell separator in an old location after scrolling).
        _forceRender(that, data, false);
    }
}

function _render(
    that: AnyComponent,
    data: AnyInternalData,
    arg: any,
    context: Context | null | void,
    isRequired: boolean,
    isOptional: boolean,
    recursion: number
) {
    DEBUG_REBACK && logger.beginBlock();
    let result;
    const previousRenderError = data.uncommonData ? data.uncommonData.renderError : null;
    if (previousRenderError) {
        result = _performRender(data, arg, previousRenderError, isRequired, isOptional, false, that);
    } else {
        // `doRender` takes care of preparing the component (calling `doRenderPending` while the preparation
        // is pending).
        result = _performRender(data, arg, null, isRequired, isOptional, false, that);
    }
    let [isPending, renderResult, renderError] = result;
    if (!isPending && renderError) {
        // When rendering in the error state after a first render iteration,
        // keep the children from the first iteration. Otherwise, the children from the
        // regular render pass would get unmounted, and a potential state change of them
        // (which might resolve the render error) would not trigger a rerender of this
        // (parent) component.
        const errorResult = _performRender(data, arg, renderError, isRequired, isOptional, true, that);
        const repeatedError = errorResult[2];
        if (repeatedError) {
            // If there's an error during doRenderError, just throw it.
            DEBUG_REBACK &&
                logger.warn(d`Repeated synchronous rendering error: ${repeatedError} after: ${renderError}`);
            if (DEBUG_REBACK) {
                getRenderAnalysisData(data).repeatedError = repeatedError;
            }
            throw repeatedError;
        } else {
            isPending = errorResult[0];
            renderResult = errorResult[1];
            renderError = null;
            if (DEBUG_REBACK) {
                getRenderAnalysisData(data).renderedAsError = true;
            }
        }
    }
    data._renderResult = renderResult;
    // Need to make sure that the phase is set to RENDERED in the end.
    // Otherwise required `forceRender` and `forcePrepare` requests are possibly ignored
    // (e.g. when `render` throws a `RenderPending` first but eventually its prepare promise resolves,
    // the phase should not be PREPARING anymore).
    data.flags = setPhaseFlags(data.flags, Phase.RENDERED);
    if (!renderState.isRenderInterrupted) {
        ++renderState.renderComponentCount;
    }
    DEBUG_REBACK && logger.endBlock();
    if (isPending) {
        DEBUG_REBACK && logger.debug(d`Caught RenderPending while rendering ${that}, re-throwing`);
        if (DEBUG_REBACK) {
            throw new RenderPending({rethrownBy: that});
        }
        throw new RenderPending();
    }
    if (data.flags & FLAG_NEEDS_RENDER_AFTER_RENDER) {
        if (recursion < 10) {
            _enterRender(that, data, context);
            return _render(that, data, arg, context, isRequired, isOptional, recursion + 1);
        } else {
            if (DEBUG_REBACK) {
                getRenderAnalysisData(data).recursionLimitReached = true;
            }
            _forceRender(that, data, false);
        }
    }
    return renderResult;
}

function tryCatch0(t, thisArg): [boolean, any] {
    try {
        return [true, t.call(thisArg)];
    } catch (e) {
        return [false, e];
    }
}

class RebackVirtualMethods<PrepareResult, RenderArgs, RenderResult, ContextType extends Context> {
    onAppear: () => void;
    onMount: () => void;
    onUnmount: () => void;
    onDisappear: () => void;
    getPrepareContextModifications: () => {[name: string]: any} | null;
    getContextModifications: (prepareResult: PrepareResult) => {[name: string]: any} | null;
    onReceiveContext: (prevContext?: ContextType) => void;
    doPrepare: () => any;
    doRender: (arg: RenderArgs, pr: PrepareResult) => any;
    doRenderPending: (arg: RenderArgs) => any;
    doRenderError: (arg: RenderArgs, error: any) => any;
    onCachedRender: (renderResult: RenderResult) => void;
    shouldPrepare: (changedAttrs: ReadonlySet<string>) => boolean;
    shouldRender: (arg: RenderArgs, pr: PrepareResult) => boolean;
    shouldWaitForChildren: () => boolean;
    shouldInterruptRender: (generation: number, time: number, components: number) => boolean;

    constructor(component: AnyComponent | RebackVirtualMethods<PrepareResult, RenderArgs, RenderResult, ContextType>) {
        this.onAppear = component.onAppear;
        this.onMount = component.onMount;
        this.onUnmount = component.onUnmount;
        this.onDisappear = component.onDisappear;
        this.getPrepareContextModifications = component.getPrepareContextModifications;
        this.getContextModifications = component.getContextModifications;
        this.onReceiveContext = component.onReceiveContext;
        this.doPrepare = component.doPrepare;
        this.doRender = component.doRender;
        this.doRenderPending = component.doRenderPending;
        this.doRenderError = component.doRenderError;
        this.onCachedRender = component.onCachedRender;
        this.shouldPrepare = component.shouldPrepare;
        this.shouldRender = component.shouldRender;
        this.shouldWaitForChildren = component.shouldWaitForChildren;
        this.shouldInterruptRender = component.shouldInterruptRender;
    }

    clone() {
        return new RebackVirtualMethods(this);
    }
}

interface CacheInterface<RenderArgs, RenderResult> {
    setEntry(key: RenderArgs, value: CacheEntry<RenderResult>): void;
    getEntry(key: RenderArgs): CacheEntry<RenderResult>;
    empty(): void;
    getSize(): number;
}

/**
 * Data that's relevant for root components.
 */
type RootData = {
    onRequestRender: (() => void) | null;
    interruptGeneration: number;
    componentCount: number;
    needsRenderTimeout: ScheduleID | null;
};

/**
 * Data that's relatively uncommon.
 * Note that this includes another indirection to RootData.
 */
type UncommonData = {
    rootData: null | RootData;
    stateWaiters: {[name: string]: Array<{value: any; resolve: () => void} | null>};
    renderError: any;
};

function getUncommonData(data: AnyInternalData): UncommonData {
    let result = data.uncommonData;
    if (!result) {
        result = data.uncommonData = {
            rootData: null,
            stateWaiters: {},
            renderError: null
        };
    }
    return result;
}

function getRootData(data: AnyInternalData): RootData {
    const uncommonData = getUncommonData(data);
    let rootData = uncommonData.rootData;
    if (!rootData) {
        rootData = uncommonData.rootData = {
            onRequestRender: null,
            interruptGeneration: 0,
            componentCount: 0,
            needsRenderTimeout: null
        };
    }
    return rootData;
}

/**
 * Data that's relevant for components that have children.
 * This is kept in a separate (nullable) property as an optimization,
 * so that components without any children don't have to store all these properties.
 */
type ChildrenData = {
    prepareChildren: Children;
    renderedChildren: Children;
    modifiedPrepareContextCache: {base?: any; modifications?: any; result?: any};
    modifiedContextCache: {base?: any; modifications?: any; result?: any};
};

function getChildrenData(data: AnyInternalData): ChildrenData {
    let result = data.childrenData;
    if (!result) {
        result = data.childrenData = {
            prepareChildren: new Map(),
            renderedChildren: new Map(),
            modifiedPrepareContextCache: {},
            modifiedContextCache: {}
        };
    }
    return result;
}

type RenderAnalysisData = {
    isInterrupted?: boolean;
    recursionLimitReached?: boolean;
    renderedAsError?: boolean;
    renderError?: any;
    renderPending?: boolean;
    renderPendingThrown?: any;
    repeatedError?: any;
    requiredButNotReady?: boolean;
    success?: boolean;
};

function getRenderAnalysisData(data: AnyInternalData): RenderAnalysisData {
    let result = data.debugRenderAnalysisData;
    if (!result) {
        result = data.debugRenderAnalysisData = {};
    }
    return result;
}

/**
 * Internal data associated with each Component. We keep this in a separate datastructure (as opposed to using properties
 * directly on the Component) mainly for two reasons:
 * 1. It's better encapsulation. There's less risk of subclasses using properties with the same name.
 * 2. It keeps many internal methods monomorphic, since we don't need to pass arbitrary Component instances to them (and access
 * their properties), but we only have to access properties on this internal datastructure.
 */
class RebackInternalData<PrepareResult, RenderArgs, RenderResult, ContextType extends Context> {
    /**
     * A bitfield containing both the component phase (in the 3 least significant bits)
     * and various boolean flags.
     */
    flags: number;

    _id: ID;

    _changedAttributesSincePrepare: Set<string> | null;
    _context: null | ContextType;
    _boundContext: null | ContextType;
    _currentlyUsedCache: CacheEntry<RenderResult> | null;

    /**
     * Potentially asynchronous preparation of the component.
     * A value of `null` is equivalent to a resolved promise.
     * The preparation result is stored in `_prepareResult` once it is done.
     */
    _prepare: SyncPromise<PrepareResult | void> | null;

    _prepareResult: PrepareResult | null;
    _renderCache: CacheInterface<RenderArgs, RenderResult>;
    _renderParent: AnyComponent | null;
    _renderParentData: AnyInternalData | null;
    _renderResult: null | RenderResult;

    /**
     * Context attributes used by this component or its descendants.
     * The straight-forward type for this would be a Set of strings,
     * but a (sorted) array of numeric keys
     * (relying on the mapping contextKeysByName in Context.js)
     * seems to be a little more efficient, in theory and practice.
     */
    _usedContextAttributes: Array<number>;

    childrenData: null | ChildrenData;

    _pendingRender: SyncPromise<void> | null;
    _pendingCompleteRender: SyncPromise<void> | null;

    /**
     * Direct pointers to lifecycle hooks and other "virtual" methods.
     * This way, they can be called directly from a RebackInternalData instance, as opposed to having to dispatch from `this`.
     * NOTE 1: Since we only populate this "cache" once in the Component structure, subclasses must define these methods
     * on their prototype. Setting e.g. `this.onMount` on an instance won't work.
     * NOTE 2: We're not storing bound method pointers, but only references to functions on the prototype.
     * So any call must make sure to pass the right `this` pointer, usually via `.call`.
     */
    methods: RebackVirtualMethods<PrepareResult, RenderArgs, RenderResult, ContextType>;

    uncommonData: UncommonData | null;

    /**
     * Start of the parent component's render pass.
     * This is only defined if `DEBUG_REBACK` is true, to avoid any performance overhead otherwise.
     */
    debugRenderParentRenderPassStart?: number | null;

    /**
     * Property for debugging what happened during the last render pass of this component and what it might be
     * "waiting for".
     * This is only defined if `DEBUG_REBACK` is true, to avoid any performance overhead otherwise.
     */
    debugRenderAnalysisData?: RenderAnalysisData | null;

    constructor(
        id: number,
        renderCache: CacheInterface<RenderArgs, RenderResult>,
        methods: RebackVirtualMethods<PrepareResult, RenderArgs, RenderResult, ContextType>
    ) {
        this.flags = Phase.CREATING;
        this._id = id;
        this._renderParent = null;
        this._renderParentData = null;
        this._context = null;
        this._boundContext = null;
        this._prepare = null;
        this._prepareResult = null;
        this._changedAttributesSincePrepare = null;
        this._renderCache = renderCache;
        this._currentlyUsedCache = null;
        this._renderResult = null;
        this._usedContextAttributes = [];
        this.childrenData = null;
        this._pendingRender = null;
        this._pendingCompleteRender = null;
        this.methods = methods;
        this.uncommonData = null;
        if (DEBUG_REBACK) {
            this.debugRenderParentRenderPassStart = null;
            this.debugRenderAnalysisData = null;
        }
    }
}

export type AnyInternalData = RebackInternalData<any, any, any, any>;

type OnChange<State extends object> = {[_name in keyof State]: (value: any, oldValue: any) => void} | void;

export default class Component<
    PrepareResult = void,
    RenderArgs = void,
    RenderResult = unknown,
    State extends {[name: string]: any} = {},
    ContextType extends Context = Context
> {
    /**
     * The current "state" of the component, similar to React's state.
     * Can be read directly via accessing `.state`, but should only be written to using `.setState`
     * (or `.setStateDuringRender` when necessary).
     * Changing the state causes the component to re-prepare and re-render (unless `shouldPrepare` or `shouldRender`
     * say otherwise, respectively).
     */
    state: State;

    cid: string;

    onChange: OnChange<State>;
    onEvent: {[name: string]: (event: any, target: AnyComponent) => void} | void;

    _reback: RebackInternalData<PrepareResult, RenderArgs, RenderResult, ContextType>;

    /**
     * Cache of "virtual" methods per component class.
     */
    static methodsCache: RebackVirtualMethods<any, any, any, any>;

    /**
     * Set a scheduler function (default: `setTimeout`).
     * This should only be used for testing purposes.
     */
    static setScheduler(schedulerFunc: SchedulerFunc, cancelScheduleFunc: CancelScheduleFunc) {
        scheduler = schedulerFunc;
        cancelSchedule = cancelScheduleFunc;
    }

    static render<Args, ComponentContextType extends Context>(
        component: Component<any, Args, any, any, ComponentContextType>,
        arg?: Args,
        options?: RenderOptions<ComponentContextType>
    ) {
        return component.renderRoot(arg, options);
    }

    static isRenderInterrupted(): boolean {
        return renderState.isRenderInterrupted;
    }

    constructor(...args: any[]) {
        const id = ++idCounter;
        this.cid = `c${id}`;
        this.state = (this.defaults() || {}) as any;
        let renderCache;
        const maxSize = this.getMaxRenderCacheSize();
        if (this.canHashRenderArg()) {
            if (maxSize === 1) {
                renderCache = new SingleEntryCache({keyHash: this.getRenderArgHash.bind(this)});
            } else {
                renderCache = new HashCache({
                    maxSize,
                    keyHash: this.getRenderArgHash.bind(this)
                });
            }
        } else {
            renderCache = new Cache({
                maxSize,
                keyComparator: sameShallow
            });
        }
        // Store the methods object on the constructor (the component class) and reuse it from there if available.
        // We want to avoid having to construct this object per instance of a component.
        // Note that we have to be careful to check for the constructor's *own* property, otherwise subclasses
        // would reuse the cache of their base classes.
        const constructor: any = this.constructor;
        let methods = constructor.hasOwnProperty('methodsCache') ? constructor.methodsCache : null;
        if (!methods) {
            methods = constructor.methodsCache = new RebackVirtualMethods(this);
        }
        const data = (this._reback = new RebackInternalData(id, renderCache, methods));
        _resetPendingRender(data);

        try {
            this.initialize(...args);
            this.postInitialize();
        } catch (error) {
            getUncommonData(data).renderError = error;
            // Remember that an error happened during initialization; we don't call any of the lifecycle hooks
            // (onAppear, onMount, onReceiveContext, onUnmount, onDisappear) in that case, since they should be able
            // to expect a fully initialized component.
            data.flags |= FLAG_ERROR_DURING_INITIALIZE;
        }
    }

    // --------------------------------------------------
    // Public methods
    // --------------------------------------------------

    initialize(...args: any) {}

    postInitialize() {}

    unrenderRoot() {
        const data = this._reback;
        if (data._renderParent) {
            DEBUG_REBACK && logger.warn('Trying to unrender a non-top-level component');
        } else {
            _unmountFromParent(this, data, null);
        }
    }

    keepMounted() {
        const data = this._reback;
        const prevParent = data._renderParent;
        const newParent = getCurrentRenderParent();
        const newParentData = getCurrentRenderParentData();
        const wasMounted = data.flags & FLAG_MOUNTED;
        if (wasMounted && prevParent === newParent && !data._pendingRender) {
            data.flags |= FLAG_KEPT_MOUNTED;
            if (newParent && newParentData) {
                _childFinishedRender(newParentData, data, this, data._renderResult);
            } else {
                DEBUG_REBACK && logger.warn(d`Keeping component ${this} mounted without any parent`);
            }
            return true;
        } else {
            data.flags &= ~FLAG_KEPT_MOUNTED;
            return false;
        }
    }

    isKeptMounted(): boolean {
        return !!(this._reback.flags & FLAG_KEPT_MOUNTED);
    }

    getContext(): ContextType {
        const data = this._reback;
        // TODO: We should probably throw an exception if there is no context yet.
        // A lot of code currently relies on getContext() returning a non-null context,
        // since it's called after or during rendering anyway.
        // @ts-ignore
        return _getBoundContext(data);
    }

    getModifiedContext(): ContextType {
        // Cache the previously generated context.
        // If this parent's context and its intended modifications stay the same,
        // keep using the same context.
        // (We don't want to notify components of context changes unnecessarily.)
        const data = this._reback;
        const methods = data.methods;
        const base = data._context || emptyContext;
        const prepareModifications = methods.getPrepareContextModifications.call(this);
        const childrenData = getChildrenData(data);
        const prepareContext = applyModificationsCached(
            base,
            prepareModifications,
            childrenData.modifiedPrepareContextCache,
            {
                sameValue: base.sameValue
            }
        );
        if (!(data.flags & FLAG_PREPARED)) {
            return prepareContext;
        }
        // Need to cast to any here since TypeScript does not understand that _isPrepared being true implies that there
        // is a prepare result.
        const prepareResult: PrepareResult = data._prepareResult as any;
        const modifications = methods.getContextModifications.call(this, prepareResult);
        return applyModificationsCached(prepareContext, modifications, childrenData.modifiedContextCache, {
            sameValue: prepareContext.sameValue
        });
    }

    /**
     * Iterates through the used context attributes of this component.
     * @param callback Function to call for each used context attribute, with the used attribute name as an argument.
     * Iteration is stopped when the callback function returns a truthy value.
     * @returns Whether the callback function returned a truthy value.
     */
    anyUsedContextAttributes(callback: (name: string) => boolean): boolean {
        return anyUsedAttribute(this._reback._usedContextAttributes, callback);
    }

    getParent(): AnyComponent | null {
        return this._reback._renderParent || null;
    }

    isMounted(): boolean {
        return !!(this._reback.flags & FLAG_MOUNTED);
    }

    isRoot(): boolean {
        const data = this._reback;
        return !!(data.flags & FLAG_MOUNTED) && !data._renderParent;
    }

    isPrepared(): boolean {
        return !!(this._reback.flags & FLAG_PREPARED);
    }

    pending() {
        if (DEBUG_REBACK) {
            return new RenderPending({source: this});
        }
        return new RenderPending();
    }

    eachChild(callback: (child: AnyComponent) => void) {
        const childrenData = this._reback.childrenData;
        if (childrenData) {
            iterChildren(childrenData.renderedChildren, callback);
        }
    }

    mapChildren<R>(callback: (child: AnyComponent) => R): R[] {
        const result: R[] = [];
        const childrenData = this._reback.childrenData;
        if (childrenData) {
            iterChildren(childrenData.renderedChildren, child => {
                result.push(callback(child));
            });
        }
        return result;
    }

    allChildren(callback: (child: AnyComponent) => boolean) {
        const childrenData = this._reback.childrenData;
        if (!childrenData) {
            return true;
        }
        return allChildren(childrenData.renderedChildren, callback);
    }

    getRenderResult(): RenderResult | null {
        return this._reback._renderResult;
    }

    /**
     * Sets an attribute, similar to Backbone's `set`.
     * However, if this happens during this component's render phase,
     * we don't schedule another render pass (which would normally happen when using `set`).
     * @param attr
     * @param value
     */
    setDuringRender(attr: string, value: any) {
        const data = this._reback;
        data.flags |= FLAG_AVOID_RENDER_AFTER_RENDER;
        this.set(attr, value);
        data.flags &= ~FLAG_AVOID_RENDER_AFTER_RENDER;
    }

    setStateDuringRender(attrs: Partial<State>) {
        const data = this._reback;
        data.flags |= FLAG_AVOID_RENDER_AFTER_RENDER;
        _setState(this, data, this.state, this.onChange, attrs as any);
        data.flags &= ~FLAG_AVOID_RENDER_AFTER_RENDER;
    }

    forceRender(options?: {notDuringRender?: boolean}) {
        _forceRender(this, this._reback, (options && options.notDuringRender) || false);
    }

    forcePrepare() {
        _forcePrepare(this, this._reback);
    }

    whenAttributeHasValue(name: string, value: any) {
        return new SyncPromise(resolve => {
            const currentValue = this.state[name];
            if (currentValue === value) {
                resolve();
            } else {
                const data = this._reback;
                const stateWaiters = getUncommonData(data).stateWaiters;
                let waiters = stateWaiters[name];
                if (!waiters) {
                    waiters = stateWaiters[name] = [];
                }
                waiters.push({value, resolve});
            }
        });
    }

    /**
     * Returns a promise that resolves to the component's context,
     * once the component has received its context.
     * *Note* that it is not safe to access attributes in that context
     * and rely on automatic re-renders of the component when those attributes change.
     * To establish a dependency on context attributes that automatically trigger
     * re-renders, make sure to access them inside a prepare or render pass.
     */
    whenContextReceived() {
        const data = this._reback;
        const context = data._context;
        if (context) {
            return SyncPromise.resolve(_getBoundContext(data));
        } else {
            return this.whenRendered().then(() => _getBoundContext(data));
        }
    }

    whenRendered() {
        const data = this._reback;
        return PromiseChain.whenDone(() => data._pendingRender || SyncPromise.resolve());
    }

    whenReady() {
        const data = this._reback;
        return PromiseChain.whenDone(() => data._prepare || SyncPromise.resolve());
    }

    whenReadyAndRendered() {
        const data = this._reback;
        return PromiseChain.whenDone(() => {
            const ready = [data._prepare];
            if (data._pendingRender) {
                ready.push(data._pendingRender);
            }
            return SyncPromise.all(ready);
        });
    }

    whenAllReady() {
        const data = this._reback;
        return PromiseChain.whenDone(() => {
            const ready: Array<SyncPromise<any> | null> = [];
            _walkTree(this, data, component => {
                ready.push(component._reback._prepare);
            });
            return SyncPromise.all(ready);
        });
    }

    whenAllReadyAndRendered() {
        const data = this._reback;
        // This is not simply a chain of `whenAllReady` and `whenRendered`, since rendering might
        // change the ready state of the component. So we need to wrap the whole combination in `whenDone`
        // which will check again after the promise resolves.
        return PromiseChain.whenDone(() => {
            const ready: Array<SyncPromise<any> | null> = [];
            _walkTree(this, data, component => {
                ready.push(component._reback._prepare);
            });
            if (data._pendingRender) {
                ready.push(data._pendingRender);
            }
            return SyncPromise.all(ready);
        });
    }

    whenRenderedCompletely(): SyncPromise<void> {
        // If there is a pending render, wait for it and then resolve asynchronously (like all the other `when*`
        // methods). This is important since the caller might expect a fully rendered component, but by the time
        // `_pendingCompleteRender` resolves, the ancestors of this component are still in the process of rendering.
        // (That would break e.g. the way NotebookLocate uses a chain of @requiresRender methods to retrieve the
        // position of the cell to scroll to.)
        return (this._reback._pendingCompleteRender || SyncPromise.resolve()).async();
    }

    isRenderedCompletely(): boolean {
        const data = this._reback;
        return !data._pendingCompleteRender || data._pendingCompleteRender.isSettled();
    }

    /**
     * Sets state attributes on this component. Changing a state attribute causes the component to re-render
     * and to re-prepare (depending on `shouldRender` and `shouldPrepare`, respectively).
     * If a change handler is defined in the `onChange` property of the component, it is also invoked.
     * This is essentially a faster alternative to Backbone attributes, with an API similar to React's `setState`.
     * @param values Dictionary of values to set. Existing attributes that don't occur in the given values are
     *               left unchanged.
     */
    setState<K extends keyof State>(values: {[P in K]: State[P] | undefined}) {
        _setState(this, this._reback, this.state, this.onChange, values as any);
    }

    /**
     * Triggers an event that (usually) bubbles up the component render tree.
     * Event listeners are set up by defining an `onEvent` object on a component instance,
     * mapping event names to handler functions. Event handlers are executed with the `this` context pointing
     * to the component they are defined in, and they receive the payload defined by the event trigger and
     * the triggering component as arguments.
     * Components can also define an `onAnyEvent` method to handle all events. This method receives the event name
     * as its first argument, before the payload and the triggering component.
     * `triggerEvent` and `onEvent` should be preferred over Backbone's event mechanism when possible
     * (especially in performance-critical code), since it avoids a lot of overhead with managing various lists of event
     * listeners etc.
     * @param name Name of the event to trigger.
     * @param event Payload to pass to the event handler as its first argument.
     * @param options Additional options: whether the event should bubble up or not.
     */
    triggerEvent(name: string, event?: any, options?: {noBubble?: boolean}) {
        let component: AnyComponent | null = this;
        const noBubble = options && options.noBubble;
        do {
            const eventListener = component.onEvent && component.onEvent[name];
            if (eventListener) {
                eventListener.call(component, event, this);
            }
            const anyEventListener = component.onAnyEvent;
            if (anyEventListener) {
                anyEventListener.call(component, name, event, this);
            }
            if (!component.shouldPropagateEvent(name, event)) {
                break;
            }
            component = component.getParent();
        } while (component && !noBubble);
    }

    shouldPropagateEvent(name: string, event: any) {
        return true;
    }

    set(...args: any) {
        if (args.length >= 2) {
            this.setState({[args[0]]: args[1]} as any);
        } else {
            this.setState(args[0]);
        }
    }

    get(name: string) {
        return this.state[name];
    }

    useContextCachesFromComponent(otherComponent: AnyComponent) {
        const data = this._reback;
        const otherData = otherComponent._reback;
        const otherChildrenData = otherData.childrenData;
        if (otherChildrenData) {
            const childrenData = getChildrenData(data);
            childrenData.modifiedPrepareContextCache = otherChildrenData.modifiedPrepareContextCache;
            childrenData.modifiedContextCache = otherChildrenData.modifiedContextCache;
        } else {
            const childrenData = data.childrenData;
            if (childrenData) {
                childrenData.modifiedPrepareContextCache = {};
                childrenData.modifiedContextCache = {};
            }
        }
    }

    setRenderRequestCallback(callback: () => any) {
        const rootData = getRootData(this._reback);
        rootData.onRequestRender = callback;
    }

    // --------------------------------------------------
    // "Virtual protected" methods meant for overriding in subclasses
    // (but don't call them directly)
    // --------------------------------------------------

    defaults(): Partial<State> {
        return {};
    }

    onAppear() {}

    onMount() {}

    onUnmount() {}

    onDisappear() {}

    getPrepareContextModifications(): {[name: string]: any} | null {
        return null;
    }

    getContextModifications(prepareResult: PrepareResult): {[name: string]: any} | null {
        return null;
    }

    canHashRenderArg(): boolean {
        return false;
    }

    getRenderArgHash(arg: RenderArgs): string {
        return '';
    }

    getMaxRenderCacheSize(): number {
        return 1;
    }

    /**
     * Called when the component receives a new context.
     * @param prevContext The previous context.
     * @deprecated Access the context in `doPrepare` or `doRender` instead,
     * which establishes automatic dependencies on context attributes and thus
     * leads to fewer surprises.
     */
    onReceiveContext(prevContext?: ContextType) {}

    doPrepare(): any {
        return null;
    }

    doRender(arg: RenderArgs, prepareResult: PrepareResult): RenderResult | void {}

    doRenderPending(arg: RenderArgs): RenderResult | void {}

    doRenderError(arg: RenderArgs, error: any): RenderResult {
        // By default, throw errors.
        throw error;
    }

    onCachedRender(renderResult: RenderResult) {}

    onAnyEvent(name: string, event: any, target: AnyComponent) {}

    shouldPrepare(changedAttributes: ReadonlySet<string>) {
        return changedAttributes.size > 0;
    }

    shouldRender(arg: RenderArgs, prepareResult: PrepareResult) {
        // When there is a cache for the given render argument, we use it by default.
        // But components could override this to require a re-render even if there is a cached result.
        return false;
    }

    shouldWaitForChildren(): boolean {
        return false;
    }

    shouldInterruptRender(generation: number, time: number, components: number): boolean {
        return false;
    }

    interruptRendering() {
        return RENDER_INTERRUPT;
    }

    // --------------------------------------------------
    // Render methods
    // --------------------------------------------------

    renderRoot(arg?: RenderArgs, options: RenderOptions<ContextType> = {}) {
        const data = this._reback;
        // First, remove the caches of all components (and their ancestors) that have been interrupted before.
        _rerenderInterrupted(data._id);
        // When starting a (top-level) render pass, remember the previous global state and reset it.
        // This is to support a top-level render pass "within" another top-level render pass.
        const oldState = resetState();
        renderState.isRendering = true;
        renderState.lastRenderWasInterrupted = !!(data.flags & FLAG_RENDER_ROOT_WAS_INTERRUPTED);
        const rootData = getRootData(data);
        renderState.lastRenderComponentCount = rootData.componentCount;
        renderState.renderInterruptGeneration = rootData.interruptGeneration;
        renderState.renderStartTime = now();
        try {
            return this.render(arg, options);
        } finally {
            const isInterrupted = renderState.isRenderInterrupted;
            if (isInterrupted) {
                data.flags |= FLAG_RENDER_ROOT_WAS_INTERRUPTED;
            } else {
                data.flags &= ~FLAG_RENDER_ROOT_WAS_INTERRUPTED;
            }
            rootData.interruptGeneration = isInterrupted ? renderState.renderInterruptGeneration : 0;
            rootData.componentCount = renderState.renderComponentCount;
            restoreState(oldState);
        }
    }

    renderRootAsync(arg?: RenderArgs, options: RenderOptions<ContextType> = {}): SyncPromise<any> {
        const data = this._reback;
        try {
            return SyncPromise.resolve(this.renderRoot(arg, {...options, isRequired: true}));
        } catch (e) {
            if (e instanceof RenderPending) {
                DEBUG_REBACK && logger.debug(d`Caught RenderPending while asynchronously rendering ${this}`);
                return new SyncPromise((resolve, reject) => {
                    const rootData = getRootData(data);
                    const oldValue = rootData.onRequestRender;
                    rootData.onRequestRender = () => {
                        rootData.onRequestRender = oldValue;
                        DEBUG_REBACK && logger.debug(d`Asynchronously rerendering ${this}`);
                        this.renderRootAsync(arg, options).then(resolve, reject);
                    };
                });
            }
            return SyncPromise.reject(e);
        }
    }

    renderRequired(arg?: RenderArgs, options: RenderOptions<ContextType> = {}) {
        return this.render(arg, {...options, isRequired: true});
    }

    renderOptional(arg: RenderArgs, options: RenderOptions<ContextType> = {}) {
        return this.render(arg, {...options, isOptional: true});
    }

    render(arg?: RenderArgs, options: RenderOptions<ContextType> = {}): RenderResult {
        DEBUG_REBACK && logger.debug(d`Rendering ${this}`);
        if (!renderState.isRendering) {
            throw new Error(
                `Rendering component ${this.toString()} outside \`Component.render\`. ` +
                    'The outermost (root) component must be rendered using `Component.render(root)`.'
            );
        }
        const data = this._reback;
        if (DEBUG_REBACK) {
            data.debugRenderAnalysisData = {};
        }
        _enterRender(this, data, options ? options.context : null);
        return _render(
            this,
            data,
            arg,
            options ? options.context : null,
            (options && options.isRequired) || false,
            (options && options.isOptional) || false,
            0
        );
    }
}

if (DEBUG_REBACK || DEBUG || PROFILE_REBACK) {
    // If we have any sort of debugging or profiling enabled, expose Reback's internal utility functions
    // in the global scope so that we can easily experiment with them, e.g. querying their optimization status.
    globals._rebackUtils = {
        _childFinishedRender,
        _doPrepare,
        _doRender,
        _enterRender,
        _forceRender,
        _invalidatePrepareCache,
        _invalidateRenderCache,
        _performRender,
        _remount,
        _render,
        _requestRender,
        _resetPendingRender,
        _setState,
        _unmountFromParent,
        _unmountPreviousChildren,
        _updateContext,
        _useCache,
        _walkTree,
        allChildren,
        iterChildren,
        tryCatch0
    };
}
