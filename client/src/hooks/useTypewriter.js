import { useState, useEffect, useRef } from "react";

/**
 * Custom hook to create a typewriter/word-by-word reveal effect.
 * Useful for streaming messages to make them feel more natural.
 * 
 * @param {string} text - The full text to display
 * @param {boolean} isEnabled - Whether the effect is active
 * @param {number} speed - Speed in ms between updates
 * @returns {string} - The currently displayed text
 */
export function useTypewriter(text, isEnabled = true, speed = 30) {
    const [displayedText, setDisplayedText] = useState(isEnabled ? "" : text);
    const displayedTextRef = useRef(isEnabled ? "" : text);
    const targetTextRef = useRef(text);

    // Keep target text updated
    useEffect(() => {
        targetTextRef.current = text;
    }, [text]);

    // Handle Enable/Disable and Initial State
    useEffect(() => {
        if (!isEnabled) {
            setDisplayedText(text);
            displayedTextRef.current = text;
        }
    }, [isEnabled, text]);

    useEffect(() => {
        if (!isEnabled) return;

        const interval = setInterval(() => {
            const current = displayedTextRef.current;
            const target = targetTextRef.current;

            if (current.length >= target.length) {
                return;
            }

            // Handle case where text content changes completely (e.g. cleared or new response)
            if (!target.startsWith(current)) {
                setDisplayedText(target);
                displayedTextRef.current = target;
                return;
            }

            const remaining = target.slice(current.length);

            // Catch-up mechanism: If backlog is huge, snap or reveal larger chunks
            // to prevent the UI from lagging behind fast LLM streams
            if (remaining.length > 300) {
                setDisplayedText(target);
                displayedTextRef.current = target;
                return;
            }

            let chunk = "";
            if (remaining.length > 100) {
                // Large backlog: reveal larger chunks up to 40 chars or next space
                const slice = remaining.slice(0, 40);
                const spaceIdx = slice.lastIndexOf(' ');
                const endIdx = spaceIdx > 10 ? spaceIdx + 1 : 40;
                chunk = remaining.slice(0, endIdx);
            } else {
                // Normal backlog: Word-by-word logic (look for next space)
                const nextSpace = remaining.indexOf(' ');
                if (nextSpace !== -1) {
                    chunk = remaining.slice(0, nextSpace + 1);
                } else {
                    chunk = remaining;
                }
            }

            const nextText = current + chunk;
            setDisplayedText(nextText);
            displayedTextRef.current = nextText;

        }, speed);

        return () => clearInterval(interval);
    }, [isEnabled, speed]);

    return isEnabled ? displayedText : text;
}

