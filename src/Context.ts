import {sameValueZero} from './util';
import * as profiling from '../profiling';

import type {AnyInternalData} from './Component';

/**
 * Mapping of (string) context names to (numeric) keys.
 * This is to avoid storing a potentially large set of strings per component instance,
 * using smaller numbers instead, assuming that there are not too many distinct
 * context attribute names.
 */
const contextKeysByName: Map<string, number> = new Map();

/**
 * Mapping of numeric keys to context names. The reverse of contextKeysByName.
 */
const contextNamesByKey: Array<string> = [];

/**
 * Bits to use per number in an array that represents a bitfield.
 * Chosen so that each number in the array is still a (non-negative) small integer ("Smi").
 */
const BITS_PER_ELEMENT = 30;

/**
 * Sets a bit in a given bitfield to 1.
 * @param bitfield Bitfield representing used context attributes.
 * @param index Index of the bit to set.
 */
function setBit(bitfield: number[], index: number) {
    const elementIndex = Math.floor(index / BITS_PER_ELEMENT);
    if (bitfield.length <= elementIndex) {
        for (let i = bitfield.length; i <= elementIndex; ++i) {
            bitfield[i] = 0;
        }
    }
    bitfield[elementIndex] |= 1 << index % BITS_PER_ELEMENT;
}

/**
 * Iterates over all used attributes in the given bitfield and
 * returns true if the given callback returns true for any of them.
 * @param bitfield Bitfield representing used context attributes.
 * @param callback Function to apply to each used attribute name.
 * @returns Whether the callback returned true for any of the used context attributes.
 */
export function anyUsedAttribute(bitfield: number[], callback: (attributeName: string) => boolean): boolean {
    for (let i = 0, l = bitfield.length; i < l; ++i) {
        const element = bitfield[i];
        if (element) {
            for (let j = 0; j < BITS_PER_ELEMENT; ++j) {
                if (element & (1 << j)) {
                    const name = contextNamesByKey[i * BITS_PER_ELEMENT + j];
                    if (callback(name)) {
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

/**
 * Adds the used context attributes from source to target.
 * @param target Bitfield representing used context attributes, which will be mutated.
 * @param source Bitfield representing new used context attributes to be added to the target.
 */
export function addUsedContextAttributes(target: number[], source: number[]) {
    const tl = target.length;
    const sl = source.length;
    let l;
    if (tl < sl) {
        for (let i = tl; i < sl; ++i) {
            target[i] = source[i];
        }
        l = tl;
    } else {
        l = sl;
    }
    for (let i = 0; i < l; ++i) {
        target[i] |= source[i];
    }
}

export default class Context {
    attributes: Map<string, any>;
    componentData: AnyInternalData | null;

    constructor(attrs?: Map<string, any>) {
        // We used to use an Immutable.Map to store the attributes, but it turns out there's quite some
        // performance overhead to that, even compared to cloning the whole dictionary whenever modifying it.
        // So we stick to pure JS for this.
        this.attributes = attrs || new Map();
        this.componentData = null;
    }

    clone() {
        // @ts-ignore
        return new this.constructor(this.attributes);
    }

    get(name: string) {
        const data = this.componentData;
        if (data) {
            // Determine the corresponding number key.
            let key = contextKeysByName.get(name);
            if (key === undefined) {
                key = contextNamesByKey.length;
                contextNamesByKey.push(name);
                contextKeysByName.set(name, key);
            }
            // Add the used context attribute to the component.
            const used = data._usedContextAttributes;
            setBit(used, key);
        }
        return this.attributes.get(name);
    }

    changeComponent(componentData: AnyInternalData) {
        const clone = this.clone();
        clone.componentData = componentData;
        return clone;
    }

    change(modifications: {[name: string]: any}) {
        PROFILE_REBACK && profiling.start('Context.change');
        let newAttrs: {[name: string]: any} | null = null;
        for (const key in modifications) {
            if (modifications.hasOwnProperty(key)) {
                const newValue = modifications[key];
                const existingValue = this.attributes.get(key);
                if (newValue !== existingValue) {
                    if (!newAttrs) {
                        newAttrs = new Map(this.attributes);
                    }
                    newAttrs.set(key, newValue);
                }
            }
        }
        PROFILE_REBACK && profiling.end('Context.change');
        if (newAttrs) {
            // @ts-ignore
            return new this.constructor(newAttrs);
        } else {
            return this;
        }
    }

    getKeys(): Iterable<string> {
        return this.attributes.keys();
    }

    sameValue(a: any, b: any, name: string) {
        return sameValueZero(a, b, name);
    }
}
