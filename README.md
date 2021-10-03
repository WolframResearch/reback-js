# Reback

A framework to define encapsulated components that make up a render tree.

Reback combines some of the ideas of [React](https://reactjs.org/) and [Backbone.js](https://backbonejs.org/).

## Goals

We want a unified way to define various *components* in the notebook interface (notebooks, cells, boxes, options, dynamic values, etc). They all have in common that

* they need to be aware of their *lifecycle* (when they appear, disappear, etc),
* there is a parent-child relationship between components, resulting in a render tree,
* they need a way to define how to *render* themselves,
* there is a *context* being passed through all levels of the render tree (e.g. current styles).

Instead of managing the lifecycle of boxes and parent-child relationships explicitly (which would be error-prone), we "declare" the dependencies during `render` and everything follows from that. Rendering a component *B* during another component *A*'s render pass automatically makes *B* the child of *A*, and when *B* is not rendered anymore as part of *A*, we know that *B* disappeared. There's often no need to attach event handlers explicitly (which poses a risk for memory leaks), instead events and render requests propagate automatically through the render tree.

This is very much like React, except that

* we need a more generalized form of `render()`, where we can pass in certain arguments (e.g. the layout width) and can return results that are not (ReactDOM) elements (e.g. the dimensions of the returned nodes),
* we need to be able to render a particular child multiple times during its parent's rendering (e.g. a GridBox "probes" its children multiple times to find the ideal column widths),
* we want to manage instantiation of components ourselves, e.g. so that a cell is not re-instantiated when the group structure changes (which would happen in React due to the way reconciliation works).

Read more about the [differences to React](docs/ReactComparison.md).

Furthermore, we want a way to express asynchronous *preparation* of components. While a component is being prepared, it can define a certain way to render in this *pending* state, and we can also express things like "render a parent as pending as long as any of its children are pending".

## Installation

Assuming you are using a package manager such as [npm](https://www.npmjs.com/get-npm) or [Yarn](https://yarnpkg.com/en/), just install this package from the npm repository:

    npm install reback-js

Then you can import `Component` and other members in your JavaScript code:

    import {Component} from 'reback-js';

## Usage & Documentation

* **[Concepts](docs/Concepts.md)**
* **[API](docs/API.md)**
* [Dos and Don'ts](docs/DosDonts.md)
* [Developer tools](docs/DevTools.md)
* [Reback in the notebook world](docs/Notebooks.md)
* [Comparison to React's component mechanism](docs/ReactComparison.md)

## Contributing

Everyone is welcome to contribute. Please read the [Contributing agreement](CONTRIBUTING.md) and the [Development guide](./docs/Development.md) for more information, including how to run the tests.

## Versioning

We use [semantic versioning](https://semver.org/) for this library and its API.

See the [changelog](CHANGELOG.md) for details about the changes in each release.
