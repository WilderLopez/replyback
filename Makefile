.PHONY: install check test typecheck types build-ios

check: typecheck test build-ios

install:
	pnpm install --frozen-lockfile

test:
	pnpm --dir worker test
	pnpm --dir cli test
	swift test

build-ios:
	xcodebuild -quiet -scheme Replyback -destination 'generic/platform=iOS' build

typecheck:
	pnpm --dir worker typecheck
	pnpm --dir cli typecheck

types:
	pnpm --dir worker types
