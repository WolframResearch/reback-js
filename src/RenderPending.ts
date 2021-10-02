import {DEBUG_REBACK} from "./globals";

function RenderPendingDebug(cause?: any) {
    // This version of the exception constructor is used when DEBUG_REBACK is enabled.
    // It "remembers" an object passed in which describes why the component is pending,
    // which can be useful for debugging.
    this.cause = cause;
}

function RenderPendingPrd() {}

const RenderPending = DEBUG_REBACK ? RenderPendingDebug : RenderPendingPrd;

export function isRenderPending(exc) {
    return exc instanceof RenderPending;
}

export default RenderPending;
