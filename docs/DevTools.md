# Reback developer tools

Reback comes with some extra functions useful for development, debugging, and profiling.

Reback exposes a global object `_r` that provides access to the developer tools. It has the following members:

* `_r.logRenderTree(component)`: logs the render tree starting at a certain component.
* `_r.logRootRenderTree(component)`: logs the render tree at the top-level ancestor of a component.
* `_r.logParents(component)`: logs all the ancestors of a component.

There are also tools for profiling, which are enabled by setting `PROFILE = true` in the Webpack configuration file:

* `_r.timings`: dictionary of timings by name. Timings are hooked up in code by calling the functions `startTiming(name)` and `stopTiming(name)` exported by `reback/devTools.js`.
