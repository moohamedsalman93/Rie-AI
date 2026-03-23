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
        console.log("useTypewriter effect trigger:", { isEnabled, textLength: text.length });
        if (!isEnabled) {
            setDisplayedText(text);
            displayedTextRef.current = text;
        } else if (displayedTextRef.current === "" && text !== "") {
            // Initial start if empty
            // Don't necessarily reset if we are just toggling enabled, 
            // but usually isEnabled is constant for a message.
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
            // Check if target still starts with current (streaming append)
            // If not, it's a replacement/reset
            if (!target.startsWith(current)) {
                setDisplayedText(target);
                displayedTextRef.current = target;
                return;
            }

            const remaining = target.slice(current.length);

            // Word-by-word logic: look for the next space
            // This makes words appear in chunks, which is "word printing"
            const nextSpace = remaining.indexOf(' ');

            let chunk = "";
            if (nextSpace !== -1) {
                // Include the space
                chunk = remaining.slice(0, nextSpace + 1);
            } else {
                // If no space found, it means we are at the end of the current buffer.
                // We can either wait for a space (can cause lag) or just show it.
                // Showing it immediately makes it feel responsive.
                chunk = remaining;
            }

            const nextText = current + chunk;
            setDisplayedText(nextText);
            displayedTextRef.current = nextText;

        }, speed);

        return () => clearInterval(interval);
    }, [isEnabled, speed]);

    return isEnabled ? displayedText : text;
}
