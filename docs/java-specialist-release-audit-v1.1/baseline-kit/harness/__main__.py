from .cli import main
import sys
try:sys.exit(main())
except (ValueError,OSError,KeyError,StopIteration) as e:print(f'ERROR: {e}',file=sys.stderr);sys.exit(2)
