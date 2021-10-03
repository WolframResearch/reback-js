import process from 'process';

let globalScope;
let hasWindow = false;
if (typeof window !== 'undefined') {
    globalScope = window;
    hasWindow = true;
} else { // @ts-ignore
    if (typeof global !== 'undefined') {
        // @ts-ignore
        globalScope = global;
    } else if (typeof self !== 'undefined') {
        globalScope = self;
    } else {
        // cf. http://www.2ality.com/2014/05/this.html
        // and http://speakingjs.com/es5/ch23.html#_indirect_eval_evaluates_in_global_scope
        globalScope = eval.call(null, 'this'); // eslint-disable-line no-eval
    }
}
// Assign to a constant to avoid exporting a mutable variable (which ESLint doesn't like).
const globalScopeConst = globalScope;

export default globalScopeConst;

export const now =
    globalScope && globalScope.performance && globalScope.performance.now ? () => performance.now() : () => Date.now();

export const DEBUG = process.env.NODE_ENV !== 'production';
export const DEBUG_REBACK = process.env.DEBUG_REBACK === 'true';
export const PROFILE_REBACK = process.env.PROFILE_REBACK === 'true';
export const IS_SERVER = process.env.IS_SERVER === 'true';
export const TESTING = process.env.TESTING === 'true';
