import { useLayoutEffect, useRef } from "react";

/** Latest committed value for subscriptions and event handlers, never rendering. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
