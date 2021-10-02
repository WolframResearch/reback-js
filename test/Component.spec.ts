import {Component} from '../src/index';
import SyncPromise from 'sync-promise-js';

describe('Component', () => {
    Component.setScheduler(
        (func, delay) => {
            SyncPromise.defer().then(func);
            return [0, 0];
        },
        () => {
            // Do nothing. We don't care about cancelling schedules here.
        }
    );

    it('renders', () => {
        class Foo extends Component<void, void, number, {}> {
            doRender() {
                return 1;
            }
        }

        const foo = new Foo();
        expect(foo.renderRoot()).toEqual(1);
    });

    it('renders children', () => {
        class ContainerComponent extends Component<void, void, number[], {}> {
            declare child1: ChildComponent;
            declare child2: ChildComponent;

            initialize() {
                this.child1 = new ChildComponent(1);
                this.child2 = new ChildComponent(2);
            }

            doRender() {
                return [this.child1.render(), this.child2.render()];
            }
        }

        class ChildComponent extends Component<void, void, number, {}> {
            declare content: number;

            initialize(content) {
                this.content = content;
            }

            doRender() {
                return this.content;
            }
        }

        const container = new ContainerComponent();
        expect(container.renderRoot()).toEqual([1, 2]);
    });

    describe('.renderRootAsync', () => {
        it('waits for asynchronous preparation', () => {
            class Foo extends Component {
                doPrepare() {
                    return SyncPromise.defer().then(() => 1);
                }

                doRender(arg, prepareResult) {
                    expect(prepareResult).toBe(1);
                    return 2;
                }
            }

            const component = new Foo();
            return Promise.resolve(component.renderRootAsync().then(result => {
                expect(result).toBe(2);
            }));
        });
    });

    describe('.unrenderRoot', () => {
        it('unmounts a top-level component', () => {
            let appearDone = false;
            let mountDone = false;
            let unmountCalled = false;

            class Foo extends Component<void, void, void, {}> {
                onAppear() {
                    appearDone = true;
                }

                onMount() {
                    expect(appearDone).toBe(true);
                    mountDone = true;
                }

                onUnmount() {
                    expect(mountDone).toBe(true);
                    unmountCalled = true;
                }
            }

            const component = new Foo();
            expect(unmountCalled).toBe(false);
            component.renderRoot();
            component.unrenderRoot();
            expect(unmountCalled).toBe(true);
        });
    });

    it('mounts prepare children again after being unmounted and rendered again', () => {
        class Container extends Component<void, void, string, {enabled: boolean}> {
            preparer = new Preparer();

            defaults() {
                return {
                    enabled: true
                };
            }

            doRender() {
                if (this.state.enabled) {
                    return this.preparer.render();
                }

                return 'nothing';
            }
        }

        class Preparer extends Component<string, void, string, {}> {
            preparee = new Preparee();

            doPrepare() {
                return this.preparee.render();
            }

            doRender(arg, prepareResult) {
                return prepareResult;
            }
        }

        class Preparee extends Component<void, void, string, {}> {
            doRender() {
                return 'prepared';
            }
        }

        const container = new Container();
        expect(container.renderRoot()).toBe('prepared');
        container.setState({
            enabled: false
        });
        expect(container.renderRoot()).toBe('nothing');
        expect(container.preparer.preparee.isMounted()).toBe(false);
        container.setState({
            enabled: true
        });
        expect(container.renderRoot()).toBe('prepared');
        expect(container.preparer.preparee.isMounted()).toBe(true);
    });

    it('calls onMount and onUnmount', () => {
        class ContainerComponent extends Component<void, number, void, {}> {
            declare children: ChildComponent[];

            initialize() {
                this.children = [new ChildComponent(), new ChildComponent()];
            }

            doRender(which) {
                return this.children[which].render();
            }
        }

        class ChildComponent extends Component<void, void, void, {}> {
            mountSpy = jest.fn();
            unmountSpy = jest.fn();

            onMount() {
                this.mountSpy();
            }

            onUnmount() {
                this.unmountSpy();
            }
        }

        const container = new ContainerComponent();
        container.renderRoot(0);
        expect(container.children[0].mountSpy).toHaveBeenCalled();
        container.renderRoot(1);
        expect(container.children[0].unmountSpy).toHaveBeenCalled();
        expect(container.children[1].mountSpy).toHaveBeenCalled();
    });

    it('does not call doRender again when shouldRender returns false', () => {
        let renderCount = 0;

        class Foo extends Component<void, void, number, {foo: number; bar: number}> {
            defaults() {
                return {
                    foo: 1,
                    bar: 2
                };
            }

            shouldRender(changed) {
                return 'foo' in changed;
            }

            doRender() {
                ++renderCount;
            }
        }

        const foo = new Foo();
        foo.renderRoot();
        expect(renderCount).toBe(1);
        foo.setState({
            foo: 2
        });
        foo.renderRoot();
        expect(renderCount).toBe(2);
        foo.setState({
            bar: 3
        });
        expect(renderCount).toBe(2);
    });

    it('keeps rendering in error state if an error happened during initialization', () => {
        class ErrorComponent extends Component<void, void, string, {}> {
            initialize() {
                throw new Error('error');
            }

            doRenderError(arg, error: Error) {
                return error.message;
            }
        }

        const instance = new ErrorComponent();
        expect(instance.renderRoot()).toBe('error');
        instance.setState({
            someNewState: 42
        });
        expect(instance.renderRoot()).toBe('error');
    });

    it('rerenders a component in an error state if a child requests a new render', () => {
        class Parent extends Component<void, void, boolean | string, {}> {
            child = new Child();

            doRenderError() {
                return 'error';
            }

            doRender() {
                const isValid = this.child.render();

                if (!isValid) {
                    throw new Error('invalid child');
                }

                return 'valid';
            }
        }

        class Child extends Component<void, void, boolean, {isValid: boolean}> {
            doRender() {
                return this.state.isValid;
            }
        }

        const parent = new Parent();
        expect(parent.renderRoot()).toBe('error');
        parent.child.setState({
            isValid: true
        });
        expect(parent.renderRoot()).toBe('valid');
    });

    it('rerenders a component in an error state if a child requests a new render and renderRoot is called on an ancestor of both components', () => {
        class Root extends Component<void, void, boolean | string, {}> {
            containedComponent = new Parent();

            doRender() {
                return this.containedComponent.render();
            }
        }

        class Parent extends Component<void, void, boolean | string, {}> {
            child = new Child();

            doRenderError() {
                return 'error';
            }

            doRender() {
                const isValid = this.child.render();

                if (!isValid) {
                    throw new Error('invalid child');
                }

                return 'valid';
            }
        }

        class Child extends Component<void, void, boolean, {isValid: boolean}> {
            doRender() {
                return this.state.isValid;
            }
        }

        const root = new Root();
        expect(root.renderRoot()).toBe('error');
        root.containedComponent.child.setState({
            isValid: true
        });
        expect(root.renderRoot()).toBe('valid');
    });

    it('rerenders a component *not* in an error state if a child requests a new render and renderRoot is called on an ancestor of both components', () => {
        class Root extends Component<void, void, boolean | string, {}> {
            containedComponent = new Parent();

            doRender() {
                return this.containedComponent.render();
            }
        }

        class Parent extends Component<void, void, boolean | string, {}> {
            child = new Child();

            doRender() {
                const isValid = this.child.render();

                if (!isValid) {
                    return 'invalid';
                }

                return 'valid';
            }
        }

        class Child extends Component<void, void, boolean, {isValid: boolean}> {
            doRender() {
                return this.state.isValid;
            }
        }

        const root = new Root();
        expect(root.renderRoot()).toBe('invalid');
        root.containedComponent.child.setState({
            isValid: true
        });
        expect(root.renderRoot()).toBe('valid');
    });

    it('rerenders a component in an error state if a prepare child requests a new render', () => {
        class Parent extends Component {
            child = new Child();

            doRenderError() {
                return 'error';
            }

            doPrepare() {
                const isValid = this.child.render();

                if (!isValid) {
                    throw new Error('invalid child');
                }

                return 'valid';
            }

            doRender(_arg, prepareResult) {
                return prepareResult;
            }
        }

        class Child extends Component<void, void, boolean, {isValid: boolean}> {
            doRender() {
                return this.state.isValid;
            }
        }

        const parent = new Parent();
        expect(parent.renderRoot()).toBe('error');
        parent.child.setState({
            isValid: true
        });
        expect(parent.renderRoot()).toBe('valid');
    });

    it('does not call doPrepare again when shouldPrepare returns false', () => {
        let prepareCount = 0;

        class Foo extends Component<number, void, undefined, {foo: number; bar; number}> {
            defaults() {
                return {
                    foo: 1,
                    bar: 2
                };
            }

            shouldPrepare(changed) {
                return changed.has('foo');
            }

            doPrepare() {
                ++prepareCount;
            }
        }

        const foo = new Foo();
        foo.renderRoot();
        expect(prepareCount).toBe(1);
        foo.setState({
            foo: 2
        });
        foo.renderRoot();
        expect(prepareCount).toBe(2);
        foo.setState({
            bar: 3
        });
        expect(prepareCount).toBe(2);
    });

    it('calls doPrepare again when a prepare child needs rendering', () => {
        let prepareCount = 0;

        class Parent extends Component<number, void, void, {}> {
            child = new Child();

            doPrepare() {
                ++prepareCount;
                return this.child.render();
            }
        }

        class Child extends Component {}

        const parent = new Parent();
        Component.render(parent);
        expect(prepareCount).toBe(1);
        parent.child.forceRender();
        Component.render(parent);
        expect(prepareCount).toBe(2);
    });

    it('calls doRender again after the component prepares', () => {
        let counter = 0;

        class Parent extends Component {
            child: Child;

            doPrepare() {
                this.child = new Child(counter++);
            }

            shouldPrepare() {
                // This component prepares every time it renders.
                return true;
            }

            doRender() {
                return this.child.render();
            }
        }

        class Child extends Component {
            value: number;

            constructor(value: number) {
                super();
                this.value = value;
            }

            doRender() {
                return this.value;
            }
        }

        const parent = new Parent();
        expect(Component.render(parent)).toBe(0);
        expect(Component.render(parent)).toBe(1);
    });

    it('handles asynchronous onAppear / onMount / onUnmount / onDisappear', () => {
        const events: string[] = [];

        class ContainerComponent extends Component {
            declare children: ChildComponent[];
            declare which: number;

            initialize() {
                this.children = [new ChildComponent('child1'), new ChildComponent('child2')];
                this.which = 0;
            }

            getContextModifications() {
                events.push('context');
                return {};
            }

            doRender() {
                events.push('render');
                return this.children[this.which].render();
            }

            shouldRender() {
                return true;
            }
        }

        class ChildComponent extends Component {
            declare name: string;

            initialize(name) {
                this.name = name;
            }

            onAppear() {
                events.push(`appear ${this.name}`);
            }

            onMount() {
                events.push(`mount ${this.name}`);
                return SyncPromise.defer();
            }

            onUnmount() {
                events.push(`unmount ${this.name}`);
                return SyncPromise.defer();
            }

            onDisappear() {
                events.push(`disappear ${this.name}`);
            }

            doRender() {
                events.push(`render ${this.name}`);
            }
        }

        const container = new ContainerComponent();
        container.setRenderRequestCallback(() => container.renderRoot());
        container.renderRoot();
        container.which = 1;
        container.renderRoot();
        // Don't wait for `container.children[0].whenRendered()`, since that is never resolved.
        return Promise.resolve(SyncPromise.all([
            container.whenReady(),
            container.whenRendered(),
            container.children[0].whenReady()
        ]).then(() => {
            expect(events).toEqual([
                'render', // context is received before onAppear and onMount are called
                'context',
                'appear child1',
                'mount child1',
                'render child1',
                'render',
                'context',
                'appear child2',
                'mount child2',
                'render child2',
                'unmount child1',
                'disappear child1'
            ]);
        }));
    });

    it('caches multiple render results', () => {
        let renderCallCount = 0;

        class Foo extends Component<void, any, any> {
            doRender(arg) {
                ++renderCallCount;
                return arg;
            }

            getMaxRenderCacheSize() {
                return 2;
            }
        }

        const foo = new Foo();
        const key = {};
        expect(foo.renderRoot(1)).toBe(1);
        expect(renderCallCount).toBe(1);
        expect(foo.renderRoot(key)).toBe(key);
        expect(renderCallCount).toBe(2);
        expect(foo.renderRoot(1)).toBe(1);
        expect(foo.renderRoot(key)).toBe(key);
        expect(renderCallCount).toBe(2);
    });

    it('invokes onCachedRender', () => {
        let cachedRenderCallCount = 0;

        class Foo extends Component<void, number, number> {
            doRender(arg) {
                return arg;
            }

            onCachedRender(_cachedResult) {
                cachedRenderCallCount++;
            }
        }

        const foo = new Foo();
        expect(foo.renderRoot(1)).toBe(1);
        expect(cachedRenderCallCount).toBe(0);
        expect(foo.renderRoot(1)).toBe(1);
        expect(cachedRenderCallCount).toBe(1);
    });
    it('renders after rendering even if render request is made by a cached child', () => {
        let childRenderCount = 0;

        class Parent extends Component<void, {showChild: boolean}, any> {
            child = new Child();

            getMaxRenderCacheSize() {
                // Remember both render results, for `showChild` being true and false.
                return 2;
            }

            doRender({showChild}) {
                return showChild ? this.child.render() : null;
            }
        }

        class Child extends Component {
            defaults() {
                return {
                    reappearCount: 0
                };
            }

            onAppear() {
                if (childRenderCount > 0) {
                    this.set('reappearCount', this.get('reappearCount') + 1);
                }
            }

            doRender() {
                return {
                    renderCount: ++childRenderCount,
                    reappearCount: this.get('reappearCount')
                };
            }
        }

        const parent = new Parent();
        parent.renderRoot({
            showChild: true
        });
        parent.renderRoot({
            showChild: false
        });
        expect(childRenderCount).toBe(1);
        // Render again with the child shown. This will use the parent's cache and will remount the child,
        // calling the child's `onAppear` handler again. That handler will change an attribute, thereby forcing
        // a re-render of the child. That re-render will be executed right away (thanks to the Component's
        // "needsRenderAfterRender" mechanism), increasing the `renderCount`.
        const result = parent.renderRoot({
            showChild: true
        });
        expect(childRenderCount).toBe(2);
        expect(result).toEqual({
            renderCount: 2,
            reappearCount: 1
        });
    });
    it('rerenders after a state change even if there has been a render error before', () => {
        class ErrorThrowing extends Component<void, void, string, {shouldThrow: boolean}> {
            defaults() {
                return {
                    shouldThrow: true
                };
            }

            doRender() {
                if (this.state.shouldThrow) {
                    throw new Error('error');
                } else {
                    return 'result';
                }
            }

            doRenderError() {
                return 'error';
            }
        }

        const instance = new ErrorThrowing();
        expect(instance.renderRoot()).toBe('error');
        instance.setState({
            shouldThrow: false
        });
        expect(instance.renderRoot()).toBe('result');
    });

    it('rerenders after a state change even if there has been a prepare error before', async () => {
        class ErrorThrowing extends Component<void, void, string, {shouldThrow: boolean}> {
            defaults() {
                return {
                    shouldThrow: true
                };
            }

            doPrepare() {
                return SyncPromise.defer().then(() => {
                    if (this.state.shouldThrow) {
                        throw new Error('error');
                    } else {
                        return 'result';
                    }
                });
            }

            doRender(arg, prepareResult) {
                return prepareResult;
            }

            doRenderError() {
                return 'error';
            }
        }

        const instance = new ErrorThrowing();
        expect(await Promise.resolve(instance.renderRootAsync())).toBe('error');
        instance.setState({
            shouldThrow: false
        });
        expect(await Promise.resolve(instance.renderRootAsync())).toBe('result');
    });

    describe('context', () => {
        it('is passed from parent to child', () => {
            class Parent extends Component<void, any, any> {
                getContextModifications() {
                    return {
                        key: 1
                    };
                }

                doRender(child) {
                    return child.render();
                }
            }

            class Child extends Component {
                doRender() {
                    return this.getContext().get('key');
                }
            }

            const parent = new Parent();
            const child = new Child();
            expect(parent.renderRoot(child)).toBe(1);
        });

        it('calls .onReceiveContext when the context changes', () => {
            let received = 0;

            class Parent extends Component<void, any, any, {key: number}> {
                defaults() {
                    return {
                        key: 0
                    };
                }

                getContextModifications() {
                    return {
                        key: this.state.key
                    };
                }

                doRender(child) {
                    return child.render();
                }
            }

            class Child extends Component {
                onReceiveContext() {
                    // Count the number of invocations.
                    ++received;
                }

                doRender() {
                    return this.getContext().get('key');
                }
            }

            const parent = new Parent();
            const child = new Child();
            parent.setState({
                key: 41
            });
            expect(parent.renderRoot(child)).toBe(41);
            expect(received).toBe(1);
            expect(parent.renderRoot(child)).toBe(41);
            expect(parent.renderRoot(child)).toBe(41);
            // Same context, so onReceiveContext hasn't been called another time even after multiple renders.
            expect(received).toBe(1);
            parent.setState({
                key: 42
            });
            expect(parent.renderRoot(child)).toBe(42);
            expect(received).toBe(2);
        });

        xit('registers context attributes used during .onReceiveContext', () => {
            class Parent extends Component<void, any, any, {key: number}> {
                defaults() {
                    return {
                        key: 0
                    };
                }

                getContextModifications() {
                    return {
                        key: this.state.key
                    };
                }

                doRender(child) {
                    return child.render();
                }
            }

            class Child extends Component {
                declare key: any;

                onReceiveContext() {
                    this.key = this.getContext().get('key');
                }

                doRender() {
                    return this.key;
                }
            }

            const parent = new Parent();
            const child = new Child();
            parent.setState({
                key: 41
            });
            expect(parent.renderRoot(child)).toBe(41);
            // This fails, and that's why using onReceiveContext is not recommended.
            parent.setState({
                key: 42
            });
            expect(parent.renderRoot(child)).toBe(42);
        });

        it('does not rerender a child when an unused context attribute changes', () => {
            let childRenderCount = 0;

            class Parent extends Component<void, any, number, {key: number; otherKey: number}> {
                defaults() {
                    return {
                        key: 0,
                        otherKey: 0
                    };
                }

                getContextModifications() {
                    return {
                        key: this.state.key,
                        otherKey: this.state.otherKey
                    };
                }

                doRender(child) {
                    return child.render();
                }
            }

            class Child extends Component {
                doRender() {
                    ++childRenderCount;
                    return this.getContext().get('key');
                }
            }

            const parent = new Parent();
            const child = new Child();
            expect(parent.renderRoot(child)).toBe(0);
            expect(childRenderCount).toBe(1);
            parent.setState({
                key: 1
            });
            expect(parent.renderRoot(child)).toBe(1);
            expect(childRenderCount).toBe(2);
            parent.setState({
                otherKey: 2
            });
            expect(parent.renderRoot(child)).toBe(1);
            expect(childRenderCount).toBe(2);
        });
        it('rerenders a previously cached child if the context changes', () => {
            class Top extends Component<void, {useContext: boolean}, any, {attr: number}> {
                declare child: Middle;

                initialize({child}) {
                    this.child = child;
                }

                getContextModifications() {
                    return {
                        attr: this.state.attr
                    };
                }

                doRender({useContext}) {
                    return this.child.render({
                        useContext
                    });
                }
            }

            class Middle extends Component<void, {useContext: boolean}, any, {}> {
                declare child: Bottom;

                initialize({child}) {
                    this.child = child;
                }

                shouldPrepare() {
                    // Force this component to prepare,
                    // which causes its internal set of used context attributes
                    // to be reset on each render.
                    return true;
                }

                getMaxRenderCacheSize(): number {
                    // Cache multiple render results,
                    // esp. one that used the context and one that didn't.
                    return 2;
                }

                doRender({useContext}) {
                    return this.child.render({
                        useContext
                    });
                }
            }

            class Bottom extends Component<void, {useContext: boolean}, number, {}> {
                doRender({useContext}) {
                    return useContext ? this.getContext().get('attr') : 0;
                }
            }

            const bottom = new Bottom();
            const middle = new Middle({
                child: bottom
            });
            const top = new Top({
                child: middle
            });
            top.setState({
                attr: 1
            });
            // The first render populates the middle cache with a result
            // that depends on the context.
            expect(
                top.renderRoot({
                    useContext: true
                })
            ).toBe(1);
            // The second render also populates the cache.
            // At that point, the middle doesn't depend on the context.
            expect(
                top.renderRoot({
                    useContext: false
                })
            ).toBe(0);
            top.setState({
                attr: 2
            });
            // Now, the bottom component re-renders even though it could
            // have used its cached render result if only the current context
            // dependencies were taken into account.
            expect(
                top.renderRoot({
                    useContext: true
                })
            ).toBe(2);
        });

        it('registers used context attributes from cached descendants after re-preparing', () => {
            class ContextProvider extends Component<void, void, any, {attr: any}> {
                declare child: Top;

                initialize({child}) {
                    this.child = child;
                }

                getContextModifications() {
                    return {
                        attr: this.state.attr
                    };
                }

                doRender() {
                    return this.child.render();
                }
            }

            class Top extends Component {
                declare child: Middle;

                initialize({child}) {
                    this.child = child;
                }

                shouldPrepare() {
                    return true;
                }

                doPrepare() {
                    return this.child.render();
                }

                doRender(arg, prepareResult) {
                    return prepareResult;
                }
            }

            class Middle extends Component {
                declare child: Bottom;

                initialize({child}) {
                    this.child = child;
                }

                getMaxRenderCacheSize(): number {
                    // Do not use a cache for middle,
                    // so that it rerenders every time and only uses a cache for
                    // bottom, from which the used context attribute will propagate
                    // back up to middle (but not further to top since middle
                    // already has it).
                    return 0;
                }

                doRender() {
                    return this.child.render();
                }
            }

            class Bottom extends Component {
                doRender() {
                    return this.getContext().get('attr');
                }
            }

            const bottom = new Bottom();
            const middle = new Middle({
                child: bottom
            });
            const top = new Top({
                child: middle
            });
            const contextProvider = new ContextProvider({
                child: top
            });
            contextProvider.setState({
                attr: 1
            });
            expect(contextProvider.renderRoot()).toBe(1);
            // Force prepare which will reset the used context attributes of top.
            top.forcePrepare();
            expect(contextProvider.renderRoot()).toBe(1);
            // Now change the context attribute which should cause bottom to re-render.
            contextProvider.setState({
                attr: 2
            });
            expect(contextProvider.renderRoot()).toBe(2);
        });
    });

    it('.whenContextReceived returns a promise resolving when a context is available', () => {
        class Parent extends Component<void, any, any> {
            doPrepare() {
                return SyncPromise.defer().then(() => 'prepareResult');
            }

            getContextModifications(prepareResult) {
                return {
                    parentPrepareResult: prepareResult
                };
            }

            doRender(child) {
                return child.render();
            }

            doRenderPending() {
                return 'pending';
            }
        }

        class Child extends Component {
            doRender() {
                return this.getContext().get('parentPrepareResult');
            }
        }

        const parent = new Parent();
        const child = new Child();
        expect(parent.renderRoot(child)).toBe('pending');
        parent.renderRootAsync(child);
        return child.whenContextReceived().then(context => {
            expect(context.get('parentPrepareResult')).toBe('prepareResult');
            expect(parent.renderRoot(child)).toBe('prepareResult');
        });
    });

    it('rendering can be interrupted and resumes at least after the previous point', () => {
        class Parent extends Component {
            child1 = new Child();
            child2 = new Child();

            doRender() {
                return [this.child1.render(), this.child2.render()];
            }

            doRenderPending() {
                return 'pending';
            }
        }

        class Child extends Component {
            shouldInterruptRender() {
                return true;
            }

            doRender() {
                return 'rendered';
            }

            doRenderPending() {
                return 'pending';
            }
        }

        const c = new Parent();
        expect(Component.render(c)).toEqual(['pending', 'pending']);
        expect(Component.render(c)).toEqual(['rendered', 'pending']);
        expect(Component.render(c)).toEqual(['rendered', 'rendered']);
    });

    it('can be used to implement a (dummy) notebook/cell/box model', () => {
        class Options extends Component {
            declare values: any;
            declare options: any;

            initialize(values) {
                // This is a simplified Options variant that only takes a single dictionary
                // of option values already extracted from an expression.
                this.values = values;
                this.options = {};

                Object.entries(this.values).forEach(([name, value]) => {
                    const OptionClass = BaseOption.getClass(name);
                    this.options[name] = new OptionClass(value);
                });
            }

            doRender() {
                const resolvedValues = {};
                const result = {
                    getResolvedValue(name) {
                        return resolvedValues[name];
                    }
                };

                Object.entries(this.options).forEach(([name, option]: [string, any]) => {
                    result[name] = option.renderRequired();
                    resolvedValues[name] = option.getResolvedValue();
                });

                return result;
            }
        }

        class BaseOption extends Component<{setting: any}, void, any, {}> {
            /*
          An option starts with the original expression (which is explicitly given in a box or cell)
          as its `originalValue`.
          Whenever it receives a context from its parent, it sets the attribute `effectiveValue`
          to either the `originalValue` (if given) or the value inherited from the parent.
          When the `effectiveValue` changes, a `DynamicValue` instance is created if necessary.
          The actual processing of the value (which is still a raw expression) happens in
          `doPrepare` (which can execute asynchronously).
          Once `doPrepare` resolves, "rendering" an option simply returns the processed setting.
           In short:
             originalValue
          -> effectiveValue
          -- (resolve any Dynamic)
          -> resolvedValue
          -- (process or processAsync)
          -> setting
          -> result of render
       */
            onChange = {
                effectiveValue(value) {
                    // When the effectiveValue attribute changes, create a DynamicValue as necessary.
                    // Note that we don't have to worry about cleaning up a previous DynamicValue here
                    // -- it will just end its lifecycle automatically by not being rendered anymore.
                    if (value && value.Dynamic) {
                        this.dynamic = new DynamicValue(value);
                    } else {
                        this.dynamic = null;
                    }
                }
            };

            declare originalValue: any;
            declare dynamic: DynamicValue | null;
            declare name: string;
            declare resolvedValue: any;

            declare static optionName;

            static getClass(name) {
                return {
                    OptionA,
                    OptionB
                }[name];
            }

            initialize(originalValue) {
                this.originalValue = originalValue;
                this.dynamic = null;
                this.name = (this.constructor as typeof BaseOption).optionName;
            }

            defaults() {
                return {
                    effectiveValue: null
                };
            }

            onReceiveContext() {
                // When the context changes, update the effectiveValue of the option
                // (in case it relied on the inherited value).
                this.set('effectiveValue', this.originalValue || this.getContext().get(this.name));
            }

            doPrepare() {
                // Either use a Dynamic's resolved value or the effective value of this option.
                this.resolvedValue = this.dynamic ? this.dynamic.renderRequired() : this.get('effectiveValue');
                return this.processAsync(this.resolvedValue).then(setting => {
                    return {
                        setting
                    };
                });
            }

            getResolvedValue() {
                return this.resolvedValue;
            }

            doRender(arg, {setting}) {
                return setting;
            }

            process(value) {
                // Default implementation is to return the original value.
                return value;
            }

            processAsync(value) {
                // Default implementation is to process synchronously
                // (but individual options can override processAsync to define an asynchronous resolution).
                return SyncPromise.resolve(this.process(value));
            }
        }

        class OptionA extends BaseOption {
            static optionName = 'OptionA';

            process(value) {
                return value;
            }
        }

        class OptionB extends BaseOption {
            static optionName = 'OptionB';

            processAsync(value) {
                // Simulate asynchronous option resolution with an artificial delay.
                // Consumers of this option will only be ready once this is resolved
                // (assuming they are using options via `renderRequired`).
                return SyncPromise.defer().then(() => {
                    return `${value} processed`;
                });
            }
        }

        class DynamicValue extends Component {
            declare dynamicExpr: any;
            declare value: any;

            initialize(dynamicExpr) {
                // Here, dynamicExpr isn't really an MExpr, but a JSON object of the form `{Dynamic: ...}`.
                this.dynamicExpr = dynamicExpr;
                this.value = null;
            }

            onAppear() {
                // Here we would make the initial kernel evaluation to fetch the current value,
                // and install a listener for future changes (which would call forceRender).
            }

            doPrepare() {
                return SyncPromise.defer().then(() => {
                    // Dummy implementation that simply extracts the 'Dynamic' field from the given "expr".
                    this.value = this.dynamicExpr.Dynamic;
                });
            }

            onDisappear() {
                // Here we would uninstall the listener for changes.
            }

            doRender() {
                // DynamicValue "renders" as its resolved value.
                return this.value;
            }
        }

        class Notebook extends Component<{options: any}> {
            declare options: Options;
            declare cells: Cell[];

            initialize() {
                // This would create options and cells based on the actual notebook data.
                // For simplicity, we don't deal with cell groups here.
                this.options = new Options({
                    OptionB: {
                        Dynamic: 'B'
                    }
                });
                this.cells = [new Cell('content')];
            }

            doPrepare() {
                return {
                    options: this.options.renderRequired()
                };
            }

            doRender() {
                // Dummy rendering that simply returns an array of the rendered cells.
                // Here we would call the NotebookView's render method,
                // which would return some React element (+ other information).
                return this.cells.map(cell => cell.render());
            }

            doRenderPending() {
                return 'pending';
            }

            getContextModifications({options}) {
                // This receives the options processed in doPrepare, and modifies the context
                // that children (cells) receive accordingly.
                // Here, we only pass on the resolved value of OptionB (i.e. after resolution of Dynamic,
                // but before any other option processing).
                return {
                    notebook: this,
                    OptionB: options ? options.getResolvedValue('OptionB') : undefined
                };
            }
        }

        class Cell extends Component {
            declare box: Box;

            initialize(content) {
                // This would create an actual box tree using `Box.fromExpr`.
                // Box creation might even happen lazily in `doRender`.
                // For simplicity, we don't deal with options here
                // (so the Cell will only pass down the context it received from the Notebook).
                this.box = new Box(content);
            }

            doRender() {
                return this.box.render();
            }
        }

        class Box extends Component<{options: any}> {
            declare options: Options;
            declare content: any;

            initialize(content) {
                // This would create options and initialize the box based on the actual box expression.
                this.options = new Options({
                    OptionA: {
                        Dynamic: 'A'
                    },
                    OptionB: null
                });
                this.content = content;
            }

            doPrepare() {
                return {
                    options: this.options.renderRequired()
                };
            }

            doRender(arg, {options}) {
                // Dummy rendering that simply returns the simple box content string
                // and the literal (resolved) option settings.
                return `${this.content} (${options.OptionA}, ${options.OptionB})`;
            }

            doRenderPending() {
                return 'pending';
            }
        }

        const notebook = new Notebook();
        // Note that we don't listen to render requests on the notebook,
        // in order to precisely test individual render phases.
        // Even though a component is reported as ready, rendering it can still produce a pending result.
        // (See the documentation of `whenAllReady`.)
        // Notebook options are not ready at first, so the whole notebook renders as pending.
        expect(notebook.renderRoot()).toEqual('pending');
        return notebook
            .whenAllReady()
            .then(() => {
                // First, the Dynamic in the Notebook's OptionB is resolved.
                // OptionB's processing is still pending, so the whole notebook is pending.
                expect(notebook.renderRoot()).toEqual('pending');
                return notebook.whenAllReady();
            })
            .then(() => {
                // Now, OptionB is fully processed, so the Notebook renders.
                // But the Cell is rendered as pending since its Box is not ready yet.
                expect(notebook.renderRoot()).toEqual(['pending']);
                return notebook.whenAllReady();
            })
            .then(() => {
                // Again, the Box's Dynamic is resolved first, but not its OptionB yet.
                expect(notebook.renderRoot()).toEqual(['pending']);
                return notebook.whenAllReady();
            })
            .then(() => {
                // Now the Box is fully ready.
                expect(notebook.renderRoot()).toEqual(['content (A, B processed)']);
            });
    });

    it('can be used to implement a box editor', () => {
        /*
        The editor is a bit tricky because we need to deal with boxes in two different "phases":
         1. Original boxes are coming from the notebook or they are created by the kernel.
            These boxes are "linearized" into a form that's suitable for editing.
            Especially, style runs are flattened out, BasicBoxes become editable text,
            and most other boxes become "atomic" (non-editable) content embedded in the editor.
         2. The editor renders content by turning it into boxes again.
            Each line has its own EditorLine component with boxes as its children.
            This can happen outside a regular render pass of the Editor component,
            because CodeMirror manages typing and calls `renderLine` directly (without starting
            at the root component, i.e. the notebook). (We might change that in the future, but it's
            easier to keep it like that for now.)
            To keep things consistent, we render *all* editor lines as root components,
            i.e. they won't have the Editor as their formal parent.
            Consequently, we need to manage the lifecycle of these lines ourselves:
            They need to be unrendered when the editor disappears, and any context changes need to be
            manually propagated to the editor lines.
        */
        class Box extends Component<{options: any}, {linearize: boolean}> {
            linearize() {
                // TODO: This should probably not render as a root, but then asynchronicity gets more complicated.
                return this.renderRootAsync({
                    linearize: true
                });
            }

            doRender({linearize}, prepareResult) {
                if (linearize) {
                    return this.doLinearize(prepareResult);
                }
                return null;
            }

            doLinearize(opts: any): any {
                return [
                    {
                        box: this
                    }
                ];
            }
        }

        class StyleBox extends Box {
            declare content: BasicBox;

            initialize() {
                this.content = new BasicBox('test');
            }

            doPrepare() {
                // This would use a real Options mechanism.
                return SyncPromise.defer().then(() => {
                    return {
                        FontSize: 12
                    };
                });
            }

            getContextModifications(prepareResult) {
                return prepareResult;
            }

            doLinearize() {
                return this.content.linearize();
            }
        }

        class BasicBox extends Box {
            declare text: string;

            initialize(text) {
                this.text = text;
            }

            doPrepare() {
                // This would use a real Options mechanism.
                const options = {
                    FontSize: this.getContext().get('FontSize')
                };
                return SyncPromise.defer().then(() => {
                    return {
                        options
                    };
                });
            }

            doLinearize({options}) {
                return [
                    {
                        text: this.text,
                        fontSize: options.FontSize
                    }
                ];
            }

            doRender({linearize}, prepareResult) {
                if (linearize) {
                    return super.doRender(
                        {
                            linearize
                        },
                        prepareResult
                    );
                }

                return this.text;
            }

            doRenderPending() {
                return 'box pending';
            }
        }

        class EditorLine extends Component<void, {boxes: any}, string> {
            doRender({boxes}) {
                // This would return a DOM node.
                return boxes.map(box => box.render({})).join(' ');
            }

            doRenderPending() {
                return 'pending';
            }

            shouldWaitForChildren() {
                return true;
            }
        }

        class Editor extends Component<{linearized: any}, any, any, {box: any}> {
            declare cm: CodeMirror | null;
            declare node: any;
            declare linearized: any;

            renderLine = line => {
                // Render an editor line by creating editor line components for each item.
                // We cache the created components in the original line item.
                // (This is important so that we don't constantly create -- and potentially prepare --
                // line components.)
                if (!line.component) {
                    line.component = new EditorLine();
                    line.component.setRenderRequestCallback(() => {
                        // Should perform a more granular refresh of this particular line.
                        this.cm!.refresh();
                    });
                }

                const boxes: Box[] = [];
                line.items.forEach(item => {
                    let box: Box | null = null;

                    if (item.box) {
                        box = item.box;
                    } else if (item.text) {
                        box = item.box = new BasicBox(item.text);
                    }

                    if (box) {
                        boxes.push(box);
                    }
                });
                return line.component.renderRoot(
                    {
                        boxes
                    },
                    {
                        context: this.getModifiedContext()
                    }
                );
            };

            unrenderLine = line => {
                if (line.component) {
                    line.component.unrenderRoot();
                }
            };

            onEditorRefresh = () => {
                // When CodeMirror repaints, re-render the Editor as well (to potentially update its dimensions).
                this.forceRender();
            };

            initialize(box) {
                this.setState({box});
                this.cm = null;
                this.node = {};
                this.linearized = null;
            }

            shouldWaitForChildren() {
                // Editor is pending as long as any of its children is pending.
                // Note that only the original box is a child of the Editor,
                // not the editor boxes that are constructed during rendering.
                return true;
            }

            doPrepare() {
                // Linearize the box (which is an asynchronous operation) and return it
                // as the prepareResult which gets passed to `doRender`.
                return this.state.box.linearize().then(linearized => {
                    return {
                        linearized
                    };
                });
            }

            getContextModifications() {
                return {
                    editor: this
                };
            }

            doRender(arg, {linearized}) {
                // Note that unless the (linearized) content changes, this does not
                // render any child boxes. Editor boxes are not actually children of the Editor.
                if (!this.cm || linearized !== this.linearized) {
                    if (this.cm) {
                        this.cm.setContent(linearized);
                    } else {
                        this.cm = new CodeMirror({
                            node: this.node,
                            content: linearized,
                            renderLine: this.renderLine,
                            unrenderLine: this.unrenderLine,
                            onRefresh: this.onEditorRefresh
                        });
                    }

                    this.linearized = linearized;
                }

                return this.node;
            }

            eachLine(callback) {
                // Iterate over the editor line components.
                this.cm!.eachLine(line => {
                    if (line.component) {
                        callback(line.component);
                    }
                });
            }

            mapLines(callback) {
                const result: any[] = [];
                this.eachLine(line => {
                    result.push(callback(line));
                });
                return result;
            }

            whenLinesReadyAndRendered() {
                return SyncPromise.all(this.mapLines(line => line.whenAllReadyAndRendered()));
            }

            onDisappear() {
                // When the editor disappears, unrender all editor lines.
                this.cm!.unrender();
            }
        }

        // Dummy CodeMirror implementation that renders into a given "node" (just a plain object here).
        // It can mutate its own content and fires an `onRefresh` event whenever it re-renders.
        class CodeMirror {
            declare node: any;
            declare lines: any[];
            declare renderLine: any;
            declare unrenderLine: any;
            declare onRefresh: any;

            constructor({node, content, renderLine, unrenderLine, onRefresh}) {
                this.node = node;
                this.lines = [];
                this.renderLine = renderLine;
                this.unrenderLine = unrenderLine;
                this.onRefresh = onRefresh;
                this.setContent(content);
            }

            refresh() {
                // In practice, editor refreshes will be more granular, and only re-render updated lines.
                this.node.content = this.lines.map(this.renderLine);
                this.onRefresh();
            }

            setContent(content) {
                this.lines.forEach(this.unrenderLine);
                // Only create a single line for simplicity here.
                this.lines = [
                    {
                        items: content
                    }
                ];
                this.refresh();
            }

            addContent(text) {
                // This is more or less what would happen on typing.
                // this.content.push({text: 'foo'});
                this.lines[0].items.push({
                    text
                });
                this.refresh();
            }

            eachLine(callback) {
                this.lines.forEach(callback);
            }

            unrender() {
                this.lines.forEach(this.unrenderLine);
            }
        }

        const box = new StyleBox();
        const editor = new Editor(box);
        // `renderRootAsync` waits for the original boxes to be ready (since Editor waits for its children).
        return Promise.resolve(editor
            .renderRootAsync()
            .then(() => {
                // But the editor lines need their own preparation, so the line will render as pending initially.
                const result = editor.renderRoot();
                expect(result).toEqual({
                    content: ['pending']
                });
                return editor.whenLinesReadyAndRendered();
            })
            .then(() => {
                // Render once again (not totally sure yet why this is necessary).
                editor.renderRoot();
                return editor.whenLinesReadyAndRendered();
            })
            .then(() => {
                // When the line is ready and rendered, it displays its text.
                const result = editor.renderRoot();
                expect(result).toEqual({
                    content: ['test']
                });
                // Add content to the editor (like typing would).
                editor.cm!.addContent('foo');
            })
            .then(() => {
                // Because of the line changed, it is pending again.
                const result = editor.renderRoot();
                expect(result).toEqual({
                    content: ['pending']
                });
                return editor.whenLinesReadyAndRendered();
            })
            .then(() => {
                // Finally, the line renders with the added text.
                const result = editor.renderRoot();
                expect(result).toEqual({
                    content: ['test foo']
                });
            }));
    });
});
