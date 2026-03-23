import { useState, useRef, useCallback } from "react";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import {
  WINDOW_SIZES,
  ANIMATION_DURATIONS,
  SNAP_MARGIN,
  SNAP_THRESHOLD,
  POSITION_CHECK_INTERVAL,
  POSITION_STABLE_THRESHOLD,
} from "../constants/appConfig";

export function useWindowManager({ isOpen, setIsOpen, windowMode }) {
  const [isSnapping, setIsSnapping] = useState(false);
  const [side, setSide] = useState("left");

  const windowRef = useRef(null);
  const isDraggingRef = useRef(false);
  const positionCheckIntervalRef = useRef(null);
  const stopAnimationRef = useRef(false);
  const pendingBubblePositionRef = useRef(null);
  const shouldSnapOnMinimizeRef = useRef(true);

  const getWindow = useCallback(() => {
    if (!windowRef.current) {
      windowRef.current = getCurrentWindow();
    }
    return windowRef.current;
  }, []);

  const getWindowPosition = useCallback(async () => {
    const win = getWindow();
    try {
      const scale = await win.scaleFactor();
      const pos = await win.outerPosition();
      return {
        x: Math.round(pos.x / scale),
        y: Math.round(pos.y / scale)
      };
    } catch (err) {
      console.error("Position fetch error:", err);
      return { x: 0, y: 0 };
    }
  }, [getWindow]);

  const getWindowSize = useCallback(async () => {
    const win = getWindow();
    try {
      const scale = await win.scaleFactor();
      const size = await win.outerSize();
      return {
        width: Math.round(size.width / scale),
        height: Math.round(size.height / scale)
      };
    } catch (err) {
      console.error("Size fetch error:", err);
      return { width: 0, height: 0 };
    }
  }, [getWindow]);

  const animateToPosition = useCallback(async (startX, startY, endX, endY, duration = ANIMATION_DURATIONS.SNAP) => {
    stopAnimationRef.current = false;
    const win = getWindow();
    const startTime = performance.now();
    const deltaX = endX - startX;
    const deltaY = endY - startY;

    const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

    return new Promise((resolve) => {
      const animateStep = async (currentTime) => {
        if (stopAnimationRef.current) {
          resolve();
          return;
        }

        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = easeOutCubic(progress);

        const currentX = Math.round(startX + deltaX * easedProgress);
        const currentY = Math.round(startY + deltaY * easedProgress);

        try {
          await win.setPosition(new LogicalPosition(currentX, currentY));
        } catch (err) {
          console.error('Animation position error:', err);
          resolve();
          return;
        }

        if (progress < 1) {
          requestAnimationFrame(animateStep);
        } else {
          resolve();
        }
      };

      requestAnimationFrame(animateStep);
    });
  }, [getWindow]);

  const snapToNearestEdge = useCallback(async () => {
    if (isOpen || windowMode === "normal") return;

    try {
      await new Promise((resolve) =>
        setTimeout(resolve, ANIMATION_DURATIONS.DRAG_SETTLE)
      );

      const [position, size] = await Promise.all([
        getWindowPosition(),
        getWindowSize(),
      ]);

      const { x: windowX, y: windowY } = position;
      const { width: windowWidth, height: windowHeight } = size;

      const {
        availWidth,
        availHeight,
        availLeft = 0,
        availTop = 0,
      } = window.screen;

      const relX = windowX - availLeft;
      const relY = windowY - availTop;

      const distances = [
        { edge: "left", dist: relX, newX: availLeft + SNAP_MARGIN, newY: windowY },
        { edge: "right", dist: availWidth - (relX + windowWidth), newX: availLeft + availWidth - windowWidth - SNAP_MARGIN, newY: windowY },
        { edge: "top", dist: relY, newX: windowX, newY: availTop + SNAP_MARGIN },
        { edge: "bottom", dist: availHeight - (relY + windowHeight), newX: windowX, newY: availTop + availHeight - windowHeight - SNAP_MARGIN },
      ];

      const nearest = distances.reduce((min, curr) =>
        curr.dist < min.dist ? curr : min
      );

      const deltaX = Math.abs(nearest.newX - windowX);
      const deltaY = Math.abs(nearest.newY - windowY);

      if (deltaX > SNAP_THRESHOLD || deltaY > SNAP_THRESHOLD) {
        setIsSnapping(true);
        await animateToPosition(windowX, windowY, nearest.newX, nearest.newY);
        setTimeout(() => setIsSnapping(false), 100);
      }
    } catch (error) {
      console.error("Snap error:", error);
    }
  }, [isOpen, windowMode, getWindowPosition, getWindowSize, animateToPosition]);

  const handleOpen = useCallback(async (centered = false) => {
    try {
      stopAnimationRef.current = true;
      setIsSnapping(false);
      isDraggingRef.current = false;
      if (positionCheckIntervalRef.current) {
        clearInterval(positionCheckIntervalRef.current);
        positionCheckIntervalRef.current = null;
      }

      await new Promise(resolve => setTimeout(resolve, 50));

      const win = getWindow();
      const pos = await getWindowPosition();
      const screenWidth = window.screen.availWidth;
      const screenHeight = window.screen.availHeight;
      const screenLeft = window.screen.availLeft || 0;
      const screenTop = window.screen.availTop || 0;

      const size = windowMode === "normal" ? WINDOW_SIZES.NORMAL : WINDOW_SIZES.CHAT;

      if (centered) {
        const targetX = screenLeft + Math.round((screenWidth - size.width) / 2);
        const targetY = screenTop + Math.round((screenHeight - size.height) / 2);
        await win.setPosition(new LogicalPosition(targetX, targetY));
      } else if (windowMode === "floating") {
        const isRightSide = pos.x > (screenLeft + screenWidth / 2);
        setSide(isRightSide ? "right" : "left");

        if (isRightSide) {
          const shiftX = WINDOW_SIZES.CHAT.width - WINDOW_SIZES.BUBBLE.width;
          await win.setPosition(new LogicalPosition(pos.x - shiftX, pos.y));
        }
      }

      await win.setSize(new LogicalSize(size.width, size.height));
      setIsOpen(true);
      await win.setFocus();
    } catch (err) {
      console.error("Failed to handle open:", err);
      setIsOpen(true);
    }
  }, [getWindow, getWindowPosition, windowMode, setIsOpen]);

  const handleMinimize = useCallback(async () => {
    if (windowMode === "normal") {
      try {
        await getWindow().minimize();
      } catch (err) {
        console.error("Failed to minimize:", err);
      }
      return;
    }
    shouldSnapOnMinimizeRef.current = true;
    pendingBubblePositionRef.current = null;
    setIsOpen(false);
  }, [windowMode, getWindow, setIsOpen]);

  const minimizeToBottomCenter = useCallback(() => {
    if (windowMode === "normal") return;
    try {
      const bubble = WINDOW_SIZES.BUBBLE;
      const { availWidth, availHeight, availLeft = 0, availTop = 0 } = window.screen;
      const margin = 20;
      const targetX = availLeft + Math.round((availWidth - bubble.width) / 2);
      const targetY = availTop + availHeight - bubble.height - margin;

      pendingBubblePositionRef.current = { x: targetX, y: targetY };
      shouldSnapOnMinimizeRef.current = false;
      setIsOpen(false);
    } catch (err) {
      console.error("Failed to minimize to bottom center:", err);
      handleMinimize();
    }
  }, [handleMinimize, windowMode, setIsOpen]);

  const handleDragStart = useCallback(async () => {
    try {
      isDraggingRef.current = true;
      await getWindow().startDragging();
    } catch {
      // Not in Tauri environment
    }
  }, [getWindow]);

  const handleBubbleMouseDown = useCallback(
    (e) => {
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;
      let dragInitiated = false;
      let lastPosition = null;
      let stableCount = 0;

      const cleanup = () => {
        if (positionCheckIntervalRef.current) {
          clearInterval(positionCheckIntervalRef.current);
          positionCheckIntervalRef.current = null;
        }
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      const triggerSnap = async () => {
        if (isOpen) {
          cleanup();
          return;
        }
        cleanup();
        isDraggingRef.current = false;
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!isOpen) await snapToNearestEdge();
      };

      const handleMouseMove = (moveEvent) => {
        const deltaX = Math.abs(moveEvent.clientX - startX);
        const deltaY = Math.abs(moveEvent.clientY - startY);

        if (deltaX > 5 || deltaY > 5) {
          moved = true;

          if (!dragInitiated) {
            dragInitiated = true;
            handleDragStart();

            setTimeout(async () => {
              lastPosition = await getWindowPosition();
            }, 100);

            positionCheckIntervalRef.current = setInterval(async () => {
              try {
                const currentPos = await getWindowPosition();

                if (lastPosition) {
                  const dx = Math.abs(currentPos.x - lastPosition.x);
                  const dy = Math.abs(currentPos.y - lastPosition.y);

                  if (dx < 2 && dy < 2) {
                    stableCount++;
                    if (stableCount >= POSITION_STABLE_THRESHOLD) {
                      await triggerSnap();
                    }
                  } else {
                    stableCount = 0;
                  }
                }
                lastPosition = currentPos;
              } catch (err) {
                console.error("Position check error:", err);
              }
            }, POSITION_CHECK_INTERVAL);
          }
        }
      };

      const handleMouseUp = async () => {
        cleanup();
        if (!moved) handleOpen();
        else if (dragInitiated) await triggerSnap();
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);

      setTimeout(() => {
        if (dragInitiated && positionCheckIntervalRef.current) {
          triggerSnap();
        }
      }, 2000);
    },
    [isOpen, handleDragStart, getWindowPosition, snapToNearestEdge, handleOpen]
  );

  return {
    isSnapping,
    side,
    getWindow,
    getWindowPosition,
    getWindowSize,
    snapToNearestEdge,
    handleOpen,
    handleMinimize,
    minimizeToBottomCenter,
    handleDragStart,
    handleBubbleMouseDown,
    pendingBubblePositionRef,
    shouldSnapOnMinimizeRef,
    positionCheckIntervalRef,
    isDraggingRef,
  };
}
