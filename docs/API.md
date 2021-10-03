# Reback API

## Render methods

Components define the following methods to control how they should be rendered:

* `doRender(arg, prepareResult)`: called when a component renders which has been prepared. It receives the result from the previous call to [`doPrepare`](#prepare).
* `doRenderPending(arg)`: called when a component is rendered that is not prepared yet (because `doPrepare` returned a promise which is not resolved yet).
* `doRenderError(arg, error)`: called when some error (e.g. an exception in `doPrepare`) prevents the component from being rendered as usual. In addition to the original argument (`arg`) to `render`, it also receives the error that was thrown.

`Component` defines a method `render` which manages the lifecycle of a component and calls the above render methods as appropriate (forwarding its first argument `arg`). It is usually not necessary to override `render`. This is the method to call to render a component as the child of another component, though.

* `render(arg, options)`: renders a component using its internal render `doRender*` methods, and returns the result from (one of) them. The rendered component becomes the child of the component that is currently being rendered. If the rendered component is not ready yet (i.e. its `doPrepare` returned a promise which is not resolved yet), the behavior depends on `shouldWaitForChildren`: If that returns `true`, the parent is considered pending (and will render using `doRenderPending`) until all of its children are ready; otherwise the parent will continue rendering using `doRender`, receiving the result of `doRenderPending` from its pending children.

The following methods can be used to force a particular behavior regardless of `shouldWaitForChildren`.

* `renderRequired(arg, options)`: renders a component (inside another component), but if it's not prepared yet, make the parent pending as well (instead of "isolating" the "pendingness" to the component itself and rendering via `doRenderPending`).
* `renderOptional(arg, options)`: renders a component (inside another component) and doesn't require it to be prepared yet, regardless of the parent's `shouldWaitForChildren`.

The top-level (root) component needs to be rendered using a special variant of `render`:

* `renderRoot(arg, options)`: renders a component as the root of a component tree. Calling `render` outside a render pass initiated by `renderRoot` is an error. (This is simply to make it explicit in the code where a render tree starts vs. where inner components are rendered, to avoid errors further down the road, e.g. when an inner components expects a certain parent or context.)
* `renderRootAsync(arg, options)`: renders a component and returns a promise resolving to the render result. The promise is pending as long as the component is pending. If there is an error while rendering, the returned promise is rejected. *Do not use this in production code yet. Its main purpose is for testing, and this API might change in the future.*
* `unrenderRoot()`: Un-renders a root component, also unmounting all its descendants. This cannot be used on a non-root component; those are unmounted by not rendering them anymore in their parents.

### Options

The first argument (`arg`) passed to `render` can be any application-defined object, e.g. something like `{width: 1000}`.

Additional options are passed in the second argument (`options`):

* `context`: An explicit context to use for the component. If this is set, the parent's context (and context modifications) will be ignored. A context object is expected to have at least the methods `.get(key)` and `.change(modifications)`. If no context is given on the root component, a default (empty) `Context` instance will be created. This should usually not be specified, except for a root component. It is recommended to use a subclass of `Context` as the context.

`options` is for options with a predefined meaning to `Component`. There might be more in the future (and also other internal, undocumented options). Any custom parameters should go into `arg`, so that they don't conflict with options.


## Initialization

* `initialize(...args)`: initializes a component when it is constructed. Receives the original arguments from the constructor call.
* `postInitialize()`: another initialization pass after `initialize` has run. This is useful if subclasses override `initialize` and, in a superclass, you want to run some code after that initialization. *Use rarely. This API might change.*


<a name="lifecycle-methods"></a>
## Lifecycle methods

As components and their children are rendered, they go through a *lifecycle*, which triggers the following methods being called:

* `onAppear()`: called when a component appears on screen.
* `onMount()`: called when a component is about to be rendered into a (new) parent (or if a root component is rendered).
* `onUnmount()`: called when a component is not rendered as part of its previous parent anymore.
* `onDisappear()`: called when a component disappears from the screen.

When a component "moves" from one parent to another, `onUnmount` is called before `onMount`. (Unmounting is not a "final" act like `remove` used to be.)

`onAppear` is called right before `onMount`; except when the component has already been mounted before (in a different parent), in which case `onAppear` is not called again.

`onDisappear` is called after `onUnmount` (in a new execution frame); except when the component is mounted again right away (in a different parent), in which case `onDisappear` is not called.

`onMount` is called before `doRender`.

Checks determining a component's mounting status:

* `isRoot()`: returns whether this component was rendered outside of any another component's render tree, using `renderRoot` or `renderRootAsync`.
* `isMounted()`: returns `true` iff this is a root component or part of a root's render tree. `isRoot()` implies `isMounted()`.


## Children

`onUnmount` is called for all descendants recursively if any of their ancestors is unmounted.

If a child stays with the same parent, neither `onUnmount` nor `onMount` are called during a render pass.

`onMount` of a parent is called (and waited to be resolved) before children's `onMount` is called.

A parent can be made to "wait" for its children to be ready:

* `shouldWaitForChildren()`: if this returns `true` and a child is still pending during `doRender`, the result of `doRender` is discarded and `doRenderPending` is called on the parent instead. This is equivalent to rendering all children with `renderRequired` instead of `render`. Even if `shouldWaitForChildren` returns `true`, a component can render pending components (without affecting its own pendingness) with `renderOptional`. Default is `false`.

Accessor methods:

* `getParent()`: returns the parent of this component.

To access children, use the following methods:

* `eachChild(callback)`: iterates over children (similar to `_.each`).
* `mapChildren(callback)`: maps over children (similar to `_.map`), returning a list of results.
* `allChildren(callback)`: iterates over children until any callback returns a falsy value, in which case it returns that value, or `true` otherwise (similar to `_.all`).

Note that children are only defined *after* `render` has been run. E.g. you can use `eachChild` and `mapChildren` in event handlers that run outside a render pass, but not inside `doRender`.

<a name="prepare"></a>
## Preparation

Components can define an asynchronous step before `doRender` is called:

* `doPrepare()`: called before `doRender`. If `doPrepare` returns a promise, the component is rendered as pending (using `doRenderPending`) until the promise resolves.
* `shouldPrepare(changedAttributes)`: determines whether `doPrepare` should be called again if it has been called already. Receives a hash of (Backbone model) attributes that have changed since the last render pass. Default is to return `true` iff any attributes changed. Otherwise, the result from the previous call to `doPrepare` will be reused. Explicit calls to `forcePrepare` and also context changes always invalidate a previous prepare result.
* `forcePrepare()`: clears any cached prepare result and forces a render pass.

The result of `doPrepare` is passed to both `doRender` and `getContextModifications`.

`doPrepare` is considered part of the rendering process, so any components rendered therein are considered children of the component. However, such child components need to be rendered *synchronously* in `doPrepare` (i.e. not after an asynchronous operation such as a `setTimeout` or another promise) since they will not be tracked properly otherwise.

An outer context change invalidates any preparation and causes a component to prepare again when it is rendered the next time.

While a component is preparing, it is rendered using `doRenderPending` or, if it is required (either because it's rendered via `renderRequired` or because its parent defines `shouldWaitForChildren` to be true), then the parent will be considered pending for as long as the component is preparing.

Methods to determine the status of asynchronous preparation:

* `isPrepared()`: whether this component has been prepared and it's preparation hasn't been invalidated in the meanwhile.
* `whenReady()`: returns a promise that resolves when this component has been prepared. It will wait until any current preparation is finished, and then check again (in case another preparation got scheduled in the meanwhile). This will always resolve asynchronously. Note that this only checks the preparation of the component itself, not any of its children.
* `whenRendered()`: returns a promise that resolves when there are no more pending render passes (due to a `forceRender`, or because the component has never been rendered yet). Note that this might never be fulfilled in case of an unmounted component that would need rendering.
* `whenReadyAndRendered()`: returns a promise that resolves when a component is ready and there are no more pending render passes.
* `whenAllReady()`: returns a promise that resolves when a component and all of its (current) descendants are ready. Note that rendering a component (even though it is currently ready) might still give a pending result, since the descendants could change during rendering (with some of them being not ready yet).
* `whenAllReadyAndRendered()`: returns a promise that resolves when a component and all of its descendants are ready and the component is rendered (a combination of `whenAllReady` and `whenRendered`).

There is an extra method to make a component pending, regardless of its preparation:

* `throwPending()`: interrupts the current render pass and puts this component into a pending state (which will either make it render using `doRenderPending`, or propagate up the render tree). *Use rarely. This API might change. And it is usually better to put anything that might cause a component to be pending into `doPrepare`, to avoid confusion.*


## Context

The *context* is a sort of dictionary that is passed top-down through the render tree. For instance, it can be used to propagate option values from a component to all its descendants.

Note that the context is not available before a component is actually mounted.

* `getContext()`: returns the context for this component, or `null` if the component has not been mounted yet. (This method should not be overridden.)
* `getContextModifications(prepareResult)`: can be overridden to return any modifications a parent wants to make to the context before that is passed on to children (in addition to `getPrepareContextModifications`). Receives the prepare result from `doPrepare`. Modifications are represented as a plain JS object. Default is to return `{}`.
* `getPrepareContextModifications()`: can be overridden to return context modifications while the component is still preparing. The resulting context is passed to children that are rendered during the prepare phase of this component. These modifications are also applied when this component is ready (in addition to the modifications from `getContextModifications`).
* `getModifiedContext()`: returns the context after any modifications (as returned by `getPrepareContextModifications` and `getContextModifications`) by this component. If this is called while `doPrepare` is pending, only the modifications from `getPrepareContextModifications` are applied. This method should not be overridden (override `getContextModifications` or `getPrepareContextModifications` instead).
* `onReceiveContext()`: called when this component receives a new context.
* `whenContextReceived()`: returns a `SyncPromise` that resolves as soon as this component receives a context for the first time (i.e. when it is mounted for the first time).

The context object itself is not a plain JS object, but an instance of `Context` or a compatible class. To access individual entries, use the method `.get(name)`. A context class also needs to implement a method `.change(modifications)`, even though that should not be used directly (it is only used internally by `getModifiedContext`).

The resulting modified contexts are cached and only a new context object is returned if either the outer context or the modifications change; so contexts are usually strictly identical (in the sense of `===`) unless something actually changes, and we don't call `onReceiveContext` unnecessarily.

* `useContextCachesFromComponent(otherComponent)`: Reuse the context caches from another component, so that this component keeps generating the same context objects as long as the outer context and modifications stay the same. This is useful when replacing one component with another but keeping the same children, and you want to avoid that these children receive a new context unnecessarily. *Use rarely. This API might change.*

## Render cache and invalidation

`render` keeps a cache of previous render results. If it's called with the same arguments again (and the context is still the same), it will return the previous result.

* `forceRender()`: triggers a `needs-render` event that bubbles up the tree, invalidating render caches along the way. At the top level, `needs-render` events are batched (until the next animation frame). Consumers of a render tree need to listen to this event and re-render accordingly.
* `shouldRender(arg, prepareResult)`: determines whether `doRender` should be called again if it has been called already. Default is to return `true` iff any (Backbone model) attributes changed since the last call to `doPrepare`. Note that a component will always re-render if it or any of its descendants was forced to render, which happens implicitly when the context of a component changes.
* `getMaxRenderCacheSize()`: can be overridden to return the maximum entries in the render cache. Default is 1.

Independently of the actual render cache, each component "remembers" its currently active render result which can be accessed using the following method:

* `getRenderResult()`: returns the currently "active" render result of this component. This returns the correct result even if a component has been rendered using its render cache (which would not cause `doRender` to be called again). So this is *not* equivalent to always just remembering the last result from `render`. If this component is not currently mounted and rendered, `null` is returned.

## Attributes

Backbone attributes have a special role in the component model: Whenever an attribute changes, a component will re-render (using `forceRender`), unless `shouldRender` returns `false`.

They are also significant in the default implementation of `shouldPrepare`: `doPrepare` will only be called another time if attributes changed in the meanwhile.

Since reacting to changes of attributes is a common operation, there is some added convenience for that:

* `onChange` (`Object.<String, function (value)>`): a dictionary mapping attribute names to functions that will be called when the respective attribute changes, receiving the new attribute value as their argument. These listeners are automatically installed when the component appears, and they are uninstalled when the component disappears. Use this instead of attaching event handlers manually.
* `whenAttributesHasValue(name, value)`: returns a `SyncPromise` that resolves when the attribute `name` has the given `value`. It will resolve synchronously when the attribute already has that value.
* `fastSet(name, value)`: an optimized variant of Backbone's `set` (with certain limitations). It only triggers change handlers in `onChange` but no other Backbone `change` events. This saves some performance overhead. *Use rarely. This API might change in the future.*

## Events

Backbone events usually propagate up the render tree.

* `onChildEvent(child, name, ...args)`: called on the parent when a child fires an event. The default implementation of `onChildEvent` re-triggers the event on the parent itself (except for `change` events, which are not propagated).

The `needs-render` event is handled internally and is not passed through `onChildEvent`.

## Exceptions

Exceptions during a render pass are generally "swallowed" in `render`. If an error occurs, `render` will call the `doRenderError` method to render an erroneous item (which is typically defined to produce a "pink box").

This is also true for an asynchronous `doPrepare` method: If it throws an error or rejects its promise, the component transitions into an error state.
