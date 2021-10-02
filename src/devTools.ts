import {anyUsedAttribute} from './Context';

import type Context from './Context';
import type {AnyComponent} from './Component';

// This is repeated from Component.js, just to avoid having to import it here.
const MASK_PHASE = 0b111;

const PHASE_NAMES = ['creating', 'mounting', 'preparing', 'rendering', 'rendered', 'unmounting', 'restoring'];
const PHASE_COLORS = {
    creating: 'gray',
    mounting: 'yellow',
    preparing: 'orange',
    rendering: 'blue',
    rendered: 'green',
    unmounting: 'red',
    restoring: 'green'
};

type LogOptions = {
    /** List of component names to "prune" in the render tree, i.e. their descendants will not be shown. */
    prune?: string[];

    /** Context key to compare at each level in the render tree. */
    compareContext?: string;

    _highlight?: AnyComponent[];
    _indentation?: number;
};

// Remember a reference to the original `console.log`, before
// setOutputFunction in loggers.js gets a chance to overwrite it.
// This is useful so we can use the Reback devtools in a debugging session
// during server-side rendering.
// We just need to ensure that this is not called during regular program execution,
// since it could mess with the Java-JS communication.
// eslint-disable-next-line no-console
const consoleLog = console.log;

function logComponent(component: AnyComponent, {compareContext, _indentation = 0, _highlight = []}: LogOptions = {}) {
    const isHighlighted = _highlight.indexOf(component) >= 0;
    let prefix = '';
    for (let i = 0; i < _indentation; ++i) {
        prefix += '  ';
    }
    if (isHighlighted) {
        prefix = `--> ${prefix.substr(4)}`;
    }
    const data = component._reback;
    const cacheSize = data._renderCache.getSize();
    const readyState = component.isPrepared() ? 'is ready' : 'not ready';
    const phase = PHASE_NAMES[data.flags & MASK_PHASE];
    let extra = '';
    let extraArgs: any[] = [];
    if (compareContext) {
        // Compare a given context value, between what the component got from its parent and the modified context
        // it will propagate to its children.
        const context: Context = component.getContext();
        const parentValue = context.get(compareContext);
        const childValue = component.getModifiedContext().get(compareContext);
        if (!context.sameValue(parentValue, childValue, compareContext)) {
            extra = ': %O -> %O';
            extraArgs = [parentValue, childValue];
        }
    }
    consoleLog(
        `%c${prefix}%c%O (%c${readyState}%c, %c${phase}%c, cache size: ${cacheSize})${extra}`,
        isHighlighted ? 'background: yellow' : '',
        '',
        component,
        component.isPrepared() ? 'color: green' : 'color: red',
        '',
        `color: ${PHASE_COLORS[phase]}`,
        '',
        ...extraArgs
    );
}

export function logRenderTree(component: AnyComponent, {prune = [], _indentation = 0, ...rest}: LogOptions = {}) {
    logComponent(component, {_indentation, ...rest});
    const name = component.constructor.name;
    if (prune.indexOf(name) < 0 && component._reback.childrenData) {
        component._reback.childrenData.renderedChildren.forEach(({instance}) => {
            logRenderTree(instance, {prune, _indentation: _indentation + 1, ...rest});
        });
    }
}

export function logRootRenderTree(component: AnyComponent, options: LogOptions) {
    const highlight = [component];
    let root = component;
    let parent;
    // eslint-disable-next-line no-cond-assign
    while ((parent = root.getParent())) {
        root = parent;
        highlight.push(parent);
    }
    logRenderTree(root, {...options, _highlight: highlight});
}

export function logParents(component: AnyComponent) {
    const parents = [component];
    let parent: AnyComponent | null = component;
    // eslint-disable-next-line no-cond-assign
    while ((parent = parent.getParent())) {
        parents.push(parent);
    }
    parents.reverse();
    parents.forEach(currentParent => {
        logComponent(currentParent, {_highlight: [component]});
    });
}

const timingStarts = {};
export const timings = {};

export function startTiming(name: string) {
    timingStarts[name] = performance.now();
}

export function stopTiming(name: string) {
    const stop = performance.now();
    const start = timingStarts[name];
    if (start) {
        timings[name] = (timings[name] || 0) + stop - start;
    }
}

export function getUsedContextAttributes(component: AnyComponent) {
    const result: string[] = [];
    anyUsedAttribute(component._reback._usedContextAttributes, name => {
        result.push(name);
        return false;
    });
    return result;
}
