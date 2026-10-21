import os

os.environ["DATABASE_URL"] = "sqlite:///./test_hireflow.db"

pytest_plugins = ["tests.helpers"]
