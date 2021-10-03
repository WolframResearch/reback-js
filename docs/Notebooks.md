# Reback in the notebook world

This document describes some of the details of how Reback is used to implement a notebook interface.

## Where to do typical cell/box-related things

* basic processing of underlying expression: in `initialize`
* create child box instances: in `initialize` (based on `this.expr`)
* create a `DynamicValue` instance: in `initialize` (based on `this.expr`) or (if it depends on options) in `doPrepare`
* retrieve the value of a `DynamicValue`: in `doPrepare` or `doRender`, usually using its method `renderRequired` (which will return a dictionary of the form `{value, serverValue, ?box}`)
    * as a Dynamic changes, it will `forceRender` itself (hence also its parent, the consumer of the Dynamic)
    * do not use the `change:value` event listener on a `DynamicValue` anymore; rely on automatic re-rendering instead
    * don't forget to render a `DynamicValue` during your box's render pass, otherwise the box will not get notified of changes (and you won't be able to take into account the dynamic value anyway)
* create an `Options` instance: in `initialize` or `postInitialize` (based on `this.expr`)
    * but you don't have to do that explicitly; it is built into `OptionsComponent`, a super class of cells and boxes
* retrieve option values: in `doPrepare` or `doRender`, usually using its method `renderRequired` (which will return a dictionary of all option and their resolved values)
    * as options change, they will `forceRender` themselves (hence also their parent, the consumer of the options)
    * the prepare result of any `OptionsComponent` (e.g. cells and boxes) contains a dictionary of `resolvedOptions`; hence explicit calls to `options.resolve` are usually not necessary (but okay, especially in existing code)

## `render` vs. `renderRequired` vs. `renderOptional`

* Use `renderRequired` whenever you assume that the render result is coming from the component's `doRender` (and not `doRenderPending`). Especially in the case of a `DynamicValue`, you'll usually assume that it's ready and you get back an object with a `value`.
* Use `renderOptional` when you explicitly don't care about whether the rendered component is ready or not; e.g. when your component depends on a `DynamicValue` but it should already render non-pendingly (using `doRender`) even if the `DynamicValue` is still pending.
* Use `render` in other cases where you don't want to make an explicit assumption about whether the child is ready or not. Depending on `shouldWaitForChildren`, this is either equivalent to `renderRequired` (if `true`) or `renderOptional` (if `false`). Boxes define `shouldWaitForChildren` to return `true`, i.e. they wait for their children to be ready, equivalently to rendering them with `renderRequired`.

## Methods that assume a cell is rendered

Methods like `Cell.evaluate` need to assume that a cell is ready and rendered, especially that all its options are resolved. The only way to reliably resolve options etc. is to actually render the cell (the options might have `Dynamic` values which need to be visible to resolve). The problem is that, in general, rendering a notebook does not render all cells, but only the visible ones.

To address this, there is a decorator `@requiresRender` (calling another method `Entity.requireRender`) that ensures that a cell is rendered before actually entering the decorated method. It will render a cell temporarily even if it wouldn't be visible otherwise.

Note that this does *not* work on the box level, because the nesting of boxes can be much more complicated and it wouldn't be easily possible to ensure that a given box is rendered by its parent (there's no concept of an explicit parent other than the render parent anyway on the box level, in contrast to the notebook/cell level). Given a box, you can only detect whether it is rendered or not (using `.isMounted()`, `.whenRendered()`, etc.) but you can't force it to become visible.

## Caveats

* You cannot access the context in the constructor or `initialize` or any time before a component is mounted. The context is propagated through the tree at render time. If you need the context while "preparing" a box, use it in `doPrepare` (which will be called again whenever the context changes) or `onReceiveContext`. Don't forget to call the inherited method (e.g. `doPrepare` in `OptionsComponent` – which `Box` inherits from – is defined to process options).
* If you render other components in `doPrepare`, you need to do so synchronously, i.e. before any asynchronous "gap" (such as waiting for another promise). Otherwise, the rendered components are not rendered at the right place in the render tree, i.e. their parent will be wrong (`render` might even throw an exception in such a case, since only `renderRoot` is allowed to render a component without a parent).

## Editor

* Editor receives initial box when created
* `content` becomes an attribute of the Editor component
* `Editor.doPrepare` calls `box.linearize()` (in `editor-content.js`) and returns the "processed content"
    * `doPrepare` will be re-run iff attributes (esp. `content`) or context change
    * `linearize` receives the current `context` as an option; returns linearized version of boxes (array of linear items, which might include reference to original boxes, so they will be rendered as "atomic" parts in the editor)
* `Editor.doRender`:
    * receives result from `doPrepare`, i.e. the linearized boxes
    * if linearized items are not the same as before (`===` check should be enough):
        * if no `CodeMirror` instance exists yet: create a `CodeMirror` instance `cm` with that content
        * if `CodeMirror` exists already: update its content (maybe try to preserve cursor position)
