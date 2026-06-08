#!/bin/bash
cd "$(dirname "$0")"
npm run dev > app.log 2>&1 &
