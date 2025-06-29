import { TRPCError } from '../error/TRPCError';
import type { ProcedureType } from '../procedure';
import { getProcedureAtPath, type AnyRouter } from '../router';
import { isObject } from '../utils';
import { parseConnectionParamsFromString } from './parseConnectionParams';
import type { TRPCAcceptHeader, TRPCRequestInfo } from './types';

type GetRequestInfoOptions = {
  path: string;
  req: Request;
  url: URL | null;
  searchParams: URLSearchParams;
  headers: Headers;
  router: AnyRouter;
};

type ContentTypeHandler = {
  isMatch: (opts: Request) => boolean;
  parse: (opts: GetRequestInfoOptions) => Promise<TRPCRequestInfo>;
};

/**
 * Memoize a function that takes no arguments
 * @internal
 */
function memo<TReturn>(fn: () => Promise<TReturn>) {
  let promise: Promise<TReturn> | null = null;
  const sym = Symbol.for('@trpc/server/http/memo');
  let value: TReturn | typeof sym = sym;
  return {
    /**
     * Lazily read the value
     */
    read: async (): Promise<TReturn> => {
      if (value !== sym) {
        return value;
      }

      // dedupes promises and catches errors
      promise ??= fn().catch((cause) => {
        if (cause instanceof TRPCError) {
          throw cause;
        }
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: cause instanceof Error ? cause.message : 'Invalid input',
          cause,
        });
      });

      value = await promise;
      promise = null;

      return value;
    },
    /**
     * Get an already stored result
     */
    result: (): TReturn | undefined => {
      return value !== sym ? value : undefined;
    },
  };
}

const jsonContentTypeHandler: ContentTypeHandler = {
  isMatch(req) {
    return !!req.headers.get('content-type')?.startsWith('application/json');
  },
  async parse(opts) {
    const { req } = opts;
    const isBatchCall = opts.searchParams.get('batch') === '1';
    const paths = isBatchCall ? opts.path.split(',') : [opts.path];

    type InputRecord = Record<number, unknown>;
    const getInputs = memo(async (): Promise<InputRecord> => {
      let inputs: unknown = undefined;
      if (req.method === 'GET') {
        const queryInput = opts.searchParams.get('input');
        if (queryInput) {
          inputs = JSON.parse(queryInput);
        }
      } else {
        inputs = await req.json();
      }
      if (inputs === undefined) {
        return {};
      }

      if (!isBatchCall) {
        return {
          0: opts.router._def._config.transformer.input.deserialize(inputs),
        };
      }

      if (!isObject(inputs)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: '"input" needs to be an object when doing a batch call',
        });
      }
      const acc: InputRecord = {};
      for (const index of paths.keys()) {
        const input = inputs[index];
        if (input !== undefined) {
          acc[index] =
            opts.router._def._config.transformer.input.deserialize(input);
        }
      }

      return acc;
    });

    const calls = await Promise.all(
      paths.map(
        async (path, index): Promise<TRPCRequestInfo['calls'][number]> => {
          const procedure = await getProcedureAtPath(opts.router, path);
          return {
            path,
            procedure,
            getRawInput: async () => {
              const inputs = await getInputs.read();
              let input = inputs[index];

              if (procedure?._def.type === 'subscription') {
                const lastEventId =
                  opts.headers.get('last-event-id') ??
                  opts.searchParams.get('lastEventId') ??
                  opts.searchParams.get('Last-Event-Id');

                if (lastEventId) {
                  if (isObject(input)) {
                    input = {
                      ...input,
                      lastEventId: lastEventId,
                    };
                  } else {
                    input ??= {
                      lastEventId: lastEventId,
                    };
                  }
                }
              }
              return input;
            },
            result: () => {
              return getInputs.result()?.[index];
            },
          };
        },
      ),
    );

    const types = new Set(
      calls.map((call) => call.procedure?._def.type).filter(Boolean),
    );

    /* istanbul ignore if -- @preserve */
    if (types.size > 1) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Cannot mix procedure types in call: ${Array.from(types).join(
          ', ',
        )}`,
      });
    }
    const type: ProcedureType | 'unknown' =
      types.values().next().value ?? 'unknown';

    const connectionParamsStr = opts.searchParams.get('connectionParams');

    const info: TRPCRequestInfo = {
      isBatchCall,
      accept: req.headers.get('trpc-accept') as TRPCAcceptHeader | null,
      calls,
      type,
      connectionParams:
        connectionParamsStr === null
          ? null
          : parseConnectionParamsFromString(connectionParamsStr),
      signal: req.signal,
      url: opts.url,
    };
    return info;
  },
};

const formDataContentTypeHandler: ContentTypeHandler = {
  isMatch(req) {
    return !!req.headers.get('content-type')?.startsWith('multipart/form-data');
  },
  async parse(opts) {
    const { req } = opts;
    if (req.method !== 'POST') {
      throw new TRPCError({
        code: 'METHOD_NOT_SUPPORTED',
        message:
          'Only POST requests are supported for multipart/form-data requests',
      });
    }
    const getInputs = memo(async () => {
      const fd = await req.formData();
      return fd;
    });
    const procedure = await getProcedureAtPath(opts.router, opts.path);
    return {
      accept: null,
      calls: [
        {
          path: opts.path,
          getRawInput: getInputs.read,
          result: getInputs.result,
          procedure,
        },
      ],
      isBatchCall: false,
      type: 'mutation',
      connectionParams: null,
      signal: req.signal,
      url: opts.url,
    };
  },
};

const octetStreamContentTypeHandler: ContentTypeHandler = {
  isMatch(req) {
    return !!req.headers
      .get('content-type')
      ?.startsWith('application/octet-stream');
  },
  async parse(opts) {
    const { req } = opts;
    if (req.method !== 'POST') {
      throw new TRPCError({
        code: 'METHOD_NOT_SUPPORTED',
        message:
          'Only POST requests are supported for application/octet-stream requests',
      });
    }
    const getInputs = memo(async () => {
      return req.body;
    });
    return {
      calls: [
        {
          path: opts.path,
          getRawInput: getInputs.read,
          result: getInputs.result,
          procedure: await getProcedureAtPath(opts.router, opts.path),
        },
      ],
      isBatchCall: false,
      accept: null,
      type: 'mutation',
      connectionParams: null,
      signal: req.signal,
      url: opts.url,
    };
  },
};

const handlers = [
  jsonContentTypeHandler,
  formDataContentTypeHandler,
  octetStreamContentTypeHandler,
];

function getContentTypeHandler(req: Request): ContentTypeHandler {
  const handler = handlers.find((handler) => handler.isMatch(req));
  if (handler) {
    return handler;
  }

  if (!handler && req.method === 'GET') {
    // fallback to JSON for get requests so GET-requests can be opened in browser easily
    return jsonContentTypeHandler;
  }

  throw new TRPCError({
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: req.headers.has('content-type')
      ? `Unsupported content-type "${req.headers.get('content-type')}`
      : 'Missing content-type header',
  });
}

export async function getRequestInfo(
  opts: GetRequestInfoOptions,
): Promise<TRPCRequestInfo> {
  const handler = getContentTypeHandler(opts.req);
  return await handler.parse(opts);
}
