import globals from 'globals';
import * as devTools from './devTools';

export {default as Component} from './Component';
export type {AnyComponent} from './Component';
export {default as Context} from './Context';
export {isRenderPending} from './RenderPending';

// Expose the devTools functions under a global object `_r`, for easy access during debugging.
globals._r = devTools;
