# Comparison to React's component mechanism

* We don't manage component *instances*. Instances are created "manually" by instantiating (subclasses of) `Component`. There is no built-in pooling mechanism.
* Because of that, it's easier to "identify" component instances. E.g. we don't need a `key` property to enable "moves" of instances. Instances can even be moved from one parent to another.
* Another implication is that we don't distinguish between *components* and *instances* as React does. When we say "component", it is an actual instance of a component class.
* We also don't distinguish between *owners* and *parents*. (Essentially, what we call "parent" would be the "owner" in React.)
* `render` does not necessarily return a `ReactElement`, but can return a custom result that can also return dimension information (width/height/baseline). `render` can receive a custom argument such as layout information (especially the current layout width).
* Hence, we have explicit calls to `render`. This also allows us to repeatedly render a component instance as part of a layout algorithm. (It's still only allowed to appear on screen once, though.)
* Backbone attributes are the analogy to React's `state`. Changing an attribute causes a component (and its ancestors) to re-render.
* Parameters to `render` (in the form of "named parameters", i.e. properties of the object passed to `render`) are the analogy to React's `props`. Passing in different parameters causes a component to re-render, unless there is a render cache for the given parameters already (which hasn't been invalidated yet, e.g. by changing attributes or a changed context).
* `getRenderResult` is similar to React's `ref`s in that it can be used to reach into the rendered result, e.g. to retrieve the dimensions stored in a rendered item after a render pass.
