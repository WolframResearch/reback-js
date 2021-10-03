# Concepts

We deal with *components* such as the notebook, cells, cell groups, boxes, and even things like options and dynamic values can be thought of as components (they might not actually render as something "visual", but they are still part of the *render tree* and have a certain *lifecycle*).

Components rendered during another component's rendering are considered the *(rendered) children* of that other component, which is called their *parent*. The set of a component's children, children's children (grand children), etc. is called the component's *descendants*. The set of a component's parent, parent's parent (grand parent), etc. is called the component's *ancestors*. The top-level component (which is rendered from code outside any other component and hence doesn't have any parent) is called the *root* component.

Since `Backbone.Model` already implements the concept of a model with observable attributes and events, we use it as the base class of `Component`. The analogy to React's `state` are Backbone attributes.

Read more about [how Reback is used to implement the notebook interface](./Notebooks.md).

Reback also provides some useful [developer tools](./DevTools.md).
