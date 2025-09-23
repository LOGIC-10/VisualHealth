"use client";

const KEY = '__vhGuestTransfer__';

export function setGuestTransfer(data) {
  if (typeof window === 'undefined') return;
  try {
    window[KEY] = data || null;
  } catch {}
}

export function consumeGuestTransfer() {
  if (typeof window === 'undefined') return null;
  try {
    const data = window[KEY] || null;
    window[KEY] = null;
    return data;
  } catch {
    return null;
  }
}

export function peekGuestTransfer() {
  if (typeof window === 'undefined') return null;
  try {
    return window[KEY] || null;
  } catch {
    return null;
  }
}

export function clearGuestTransfer() {
  if (typeof window === 'undefined') return;
  try {
    window[KEY] = null;
  } catch {}
}
