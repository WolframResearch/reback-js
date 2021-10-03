# Dos and Don'ts

Any *allocations* (e.g. events being registered) should be done in `onAppear` or `onMount`, and they should be "undone" in `onUnmount` or `onDisappear`.

The constructor of an item should not perform any allocations. (The counterpart to the constructor is garbage collection, which cannot perform any custom deallocations.)

It is allowed to call `render` multiple times during its parent's `render` (e.g. to figure out the optimal widths of columns in a grid).

It is not allowed to render the same item into multiple parents simultaneously.

It is allowed to "move" an item from one parent to another. In that case, `onUnmount` is called before `onMount`.

Methods starting with `on`, `should`, or `do` (and also `getContextModifications`, `getPrepareContextModifications`, `getMaxRenderCacheSize`) are "virtual" methods meant for overriding. Other methods (such as `render` and `forceRender`) should not be overridden in subclasses of `Component` (they are only there to be *called*). You don't *have* to override any methods, though: A component which does not define any methods is *okay* (although it won't actually do much).

Components should not manually install event listeners on child components. That happens automatically (with guaranteed cleanup), so that any child events are re-triggered on the parent. Any custom event handling beyond that can be done by overriding `onChildEvent`. Event handlers on the component itself should be defined via the `onChange` property.
