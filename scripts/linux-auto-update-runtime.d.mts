export declare class AcceptanceHttpExecutor {
  download(
    url: URL,
    destination: string,
    options: {
      cancellationToken: {
        createPromise<T>(
          executor: (
            resolve: (value: T) => void,
            reject: (reason?: unknown) => void,
            onCancel: (handler: () => void) => void,
          ) => void,
        ): Promise<T>;
      };
      headers?: Record<string, string>;
      sha512?: string;
      sha2?: string;
    },
  ): Promise<string>;
}
