export const asyncHandler = <T>(
  fn: (req: any, res: any, next: any) => Promise<T>
) => {
  return (req: any, res: any, next: any) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
