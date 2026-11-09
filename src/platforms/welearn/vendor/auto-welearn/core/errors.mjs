// Auto-WeLearn; GPL-3.0; see ../../NOTICE.md and original source.
/**
 * 错误码与自定义错误类。错误码即用户可见的诊断语言，
 * 与 docs/NODE_CLI_SPEC.md §8 的错误处理矩阵一一对应。
 */

                       
                   
             
                  
                  
                  
                      
                 
                      
                 
                   
                  
                     
                      
                   
                       
              

/** 这些错误码重试有意义；4xx 与契约变更不重试 */
const RETRYABLE                         = new Set           ([
  'NETWORK_ERROR',
  'TIMEOUT',
  'SERVER_ERROR',
]);

/** 这些错误码出现即必须终止整条队列 */
const FATAL                         = new Set           ([
  'AUTH_EXPIRED',
  'CONFIG_ERROR',
  'BAD_CREDENTIALS',
  'SSO_FLOW_CHANGED',
]);

                                  
                  
                  
                  
                  
                 
                      
 

export class AppError extends Error {
           code           ;
           status         ;
           retryable         ;
                    cause          ;

  constructor(opts                 ) {
    super(opts.message);
    this.name = 'AppError';
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? RETRYABLE.has(opts.code);
    this.cause = opts.cause;
  }

  static isFatal(code           )          {
    return FATAL.has(code);
  }

  static isRetryable(code           )          {
    return RETRYABLE.has(code);
  }
}

export class ConfigError extends AppError {
  constructor(message        ) {
    super({ code: 'CONFIG_ERROR', message, retryable: false });
    this.name = 'ConfigError';
  }
}

/** 把任意抛出物归一化成 AppError，便于统一处理 */
export function toAppError(err         , fallbackCode            = 'UNKNOWN')           {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return new AppError({ code: 'INTERRUPTED', message: '操作已被中断', cause: err, retryable: false });
    }
    return new AppError({ code: fallbackCode, message: err.message, cause: err });
  }
  return new AppError({ code: fallbackCode, message: String(err), cause: err });
}

/** 退出码映射，见 §6.4 */
export function exitCodeFor(err                 , hasFailure         )         {
  if (!err) return hasFailure ? 1 : 0;
  switch (err.code) {
    case 'CONFIG_ERROR':
      return 2;
    case 'AUTH_EXPIRED':
    case 'BAD_CREDENTIALS':
    case 'SSO_FLOW_CHANGED':
      return 3;
    case 'INTERRUPTED':
      return 4;
    case 'CONTRACT_CHANGED':
      return 5;
    default:
      return 1;
  }
}
