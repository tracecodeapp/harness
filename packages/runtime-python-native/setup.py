from setuptools import Extension, setup

setup(
    ext_modules=[
        Extension(
            "_tracecode_native",
            sources=["src/tracecode_native.c"],
        )
    ]
)
