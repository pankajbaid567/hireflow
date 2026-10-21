"""Shared skill vocabulary and boundary-aware matching for prep and reports."""

import re

SKILLS = (
    "Python",
    "JavaScript",
    "TypeScript",
    "Java",
    "Go",
    "Rust",
    "C++",
    "C#",
    "SQL",
    "HTML",
    "CSS",
    "React",
    "Next.js",
    "Node.js",
    "FastAPI",
    "Django",
    "Flask",
    "Spring",
    "LangChain",
    "LangGraph",
    "RAG",
    "multi-agent systems",
    "Docker",
    "Kubernetes",
    "AWS",
    "Azure",
    "GCP",
    "PostgreSQL",
    "MongoDB",
    "Redis",
    "Git",
    "Linux",
    "TensorFlow",
    "PyTorch",
    "scikit-learn",
    "Pandas",
    "NumPy",
    "machine learning",
    "deep learning",
    "data structures",
    "algorithms",
    "system design",
    "REST",
    "GraphQL",
    "Terraform",
    "CI/CD",
    "Kotlin",
    "Swift",
    "Ruby",
    "PHP",
    "Vue",
    "Angular",
    "Excel",
)
ALIASES = {
    "nodejs": "node.js",
    "reactjs": "react",
    "postgres": "postgresql",
    "js": "javascript",
    "ts": "typescript",
    "k8s": "kubernetes",
}


def normalize_skill(skill):
    value = skill.lower().strip()
    return ALIASES.get(value, value)


def has_skill(text, skill):
    return (
        re.search(r"(?<![\w+#])" + re.escape(skill) + r"(?![\w+#])", text, re.I)
        is not None
    )


def extract_skills(text, extra=()):
    vocabulary = dict.fromkeys((*SKILLS, *extra))
    return [skill for skill in vocabulary if has_skill(text, skill)]
