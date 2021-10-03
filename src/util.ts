import RenderPending from './RenderPending';

/**
 * Tests whether two values are the same, with 0 being the same as -0 and NaN being the same as NaN.
 * @param a
 * @param b
 * @returns {boolean}
 */
export function sameValueZero(a: unknown, b: unknown, key?: any) {
    // cf. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Equality_comparisons_and_sameness
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/**
 * Compares two objects shallowly.
 * @param a
 * @param b
 * @param {function} sameValue
 * @returns {boolean}
 */
export function sameShallow(a, b, {sameValue = sameValueZero} = {}) {
    if (sameValue(a, b, null)) {
        return true;
    }
    if (!a || !b) {
        return false;
    }
    if (typeof a !== typeof b) {
        // Test types to catch cases like `sameShallow(1, {})` where both objects
        // have no properties.
        return false;
    }
    for (const key in a) {
        if (a.hasOwnProperty(key)) {
            if (!b.hasOwnProperty(key) || !sameValue(a[key], b[key], key)) {
                return false;
            }
        }
    }
    for (const key in b) {
        if (b.hasOwnProperty(key)) {
            if (!a.hasOwnProperty(key)) {
                return false;
            }
            // If both `a` and `b` have this property, then its value was already compared in the previous loop
            // over `a`.
        }
    }
    return true;
}

/**
 * Applies modifications to a context, caching the result and reusing it when the same base and modifications
 * are passed in the next time.
 * @param {Context} base
 * @param {Object} modifications
 * @param {{base, modifications, result}} cache
 * @param {{sameValue}} options
 * @returns {*}
 */
export function applyModificationsCached(base, modifications, cache, options) {
    if (!modifications) {
        return base;
    }
    if (cache.base === base && sameShallow(cache.modifications, modifications, options)) {
        return cache.result;
    }
    const result = base.change(modifications);
    cache.base = base;
    cache.modifications = modifications;
    cache.result = result;
    return result;
}

type CompareResult =
    | boolean
    | {
          aMinusB: any[];
          bMinusA: any[];
          differentValue: any[];
      };

export function compareMaps(a, b): CompareResult {
    if (a === b) {
        return true;
    }
    if (!a || !b) {
        return false;
    }
    const result: CompareResult = {aMinusB: [], bMinusA: [], differentValue: []};
    for (const [key, value] of a) {
        if (!b.has(key)) {
            result.aMinusB.push(key);
        }
        if (!sameValueZero(value, b.get(key))) {
            result.differentValue.push(key);
        }
    }
    for (const [key, __] of b) {
        if (!a.has(key)) {
            result.bMinusA.push(key);
        }
    }
    return result;
    // This was relevant when using Immutable.Map:
    // return compareObjects(a.toObject(), b.toObject());
}

/**
 * Template string tag for debug output, serializing objects in a log-friendly way.
 * cf. https://developer.mozilla.org/en/docs/Web/JavaScript/Reference/Template_literals#Tagged_template_literals
 * @param strings
 * @param values
 * @returns {string}
 */
export function d(strings, ...values) {
    const result: string[] = [];
    for (let i = 0; i < strings.length; ++i) {
        result.push(strings[i]);
        if (i < values.length) {
            const value = values[i];
            let str;
            if (value && value.cid) {
                str = `[${value.constructor.name}: ${value.cid}]`;
            } else if (value === undefined) {
                str = 'undefined';
            } else if (typeof value === 'string') {
                str = value;
            } else if (value instanceof RenderPending) {
                str = '[RenderPending]';
            } else if (value instanceof Error) {
                str = `[Error: ${value.toString()}`; // + ']';
                if (value.stack) {
                    str += `\n${value.stack}`;
                }
                str += ']';
            } else {
                try {
                    str = JSON.stringify(value);
                    if (str.length > 1000) {
                        str = `${str.substr(0, 1000)} [...]`;
                    }
                } catch (e) {
                    // in case of circular references in the object
                    str = '[Object]';
                }
            }
            result.push(str);
        }
    }
    return result.join('');
}

/**
 * Merges two sorted arrays with unique elements into a single sorted array with unique elements.
 * @param target Array of numbers to be mutated, so it includes all numbers from the source array.
 * @param source Array of numbers to be added to the target array.
 * @returns whether the target array was modified
 */
export function mergeSortedArrays(target: number[], source: number[]): boolean {
    let index1 = 0;
    let index2 = 0;
    let didChange = false;

    while (index2 < source.length) {
        const val = source[index2];
        const targetLength = target.length;
        if (index1 >= targetLength) {
            ++index2;
            let shouldAdd = true;
            if (targetLength > 0) {
                const lastTargetVal = target[targetLength - 1];
                if (lastTargetVal === val) {
                    shouldAdd = false;
                }
            }
            if (shouldAdd) {
                didChange = true;
                target.push(val);
            }
        } else {
            const targetVal = target[index1];
            if (targetVal < val) {
                ++index1;
            } else if (targetVal > val) {
                ++index2;
                didChange = true;
                target.splice(index1, 0, val);
            } else {
                ++index2;
            }
        }
    }
    return didChange;
}
