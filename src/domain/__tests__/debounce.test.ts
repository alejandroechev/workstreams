import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounce } from "../debounce";

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("only fires once after the wait window elapses", () => {
    const spy = vi.fn();
    const d = debounce(spy, 100);
    d("a");
    d("b");
    d("c");
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("c");
  });

  it("uses the LAST arguments passed", () => {
    const spy = vi.fn();
    const d = debounce(spy, 50);
    d(1, "first");
    d(2, "second");
    d(3, "third");
    vi.advanceTimersByTime(50);
    expect(spy).toHaveBeenCalledWith(3, "third");
  });

  it("resets the timer on each call", () => {
    const spy = vi.fn();
    const d = debounce(spy, 100);
    d("a");
    vi.advanceTimersByTime(80);
    d("b"); // resets the 100ms window
    vi.advanceTimersByTime(80);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("b");
  });

  it("cancel drops the pending invocation", () => {
    const spy = vi.fn();
    const d = debounce(spy, 50);
    d("a");
    d.cancel();
    vi.advanceTimersByTime(100);
    expect(spy).not.toHaveBeenCalled();
  });

  it("cancel is a no-op when nothing is pending", () => {
    const spy = vi.fn();
    const d = debounce(spy, 50);
    d.cancel();
    d.cancel();
    expect(() => d.cancel()).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("can be reused after a fire completes", () => {
    const spy = vi.fn();
    const d = debounce(spy, 30);
    d("a");
    vi.advanceTimersByTime(30);
    expect(spy).toHaveBeenCalledTimes(1);
    d("b");
    vi.advanceTimersByTime(30);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith("b");
  });
});
