export * from './transformer';

// <FIXME:delete me>
// export * from './types';
export * from './core';
export { type DefaultErrorShape } from './error/formatter';
export type { RootConfig, AnyRootConfig } from './core/internals/config';
// </FIXME:delete me>
export { TRPCError } from './error/TRPCError';
export { initTRPC } from './core/initTRPC';

/**
 * ⚠️ ⚠️ ⚠️ Danger zone ⚠️ ⚠️ ⚠️
 * @remark
 * Do not use things from this export as they are subject to change without notice. They only exists to support `.d.ts`-files
 * If you need something from here, please open an issue and we can probably expose it in a stable way.
 * @deprecated
 */
export * as unstableExternalsExport from './unstableInternalsExport';
