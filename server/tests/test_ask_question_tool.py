import unittest
import json
from app.question_tools import ask_question, normalize_question_payload
from app.tools import ask_question as exported_ask_question


class TestAskQuestionTool(unittest.TestCase):
    def test_single_question_canonical_format(self):
        result = ask_question(
            question="What would you like me to do with your resume?",
            options=["Review & give feedback", "Tailor it for a specific job", "Check ATS-friendliness"],
            is_multi_select=False,
            allow_custom=True,
            placeholder="Something else...",
            header="Resume"
        )
        self.assertEqual(result["status"], "asked")
        self.assertEqual(result["header"], "Resume")
        self.assertEqual(len(result["questions"]), 1)
        
        q0 = result["questions"][0]
        self.assertEqual(q0["id"], "q_0")
        self.assertEqual(q0["question"], "What would you like me to do with your resume?")
        self.assertEqual(q0["header"], "Resume")
        self.assertEqual(q0["options"], ["Review & give feedback", "Tailor it for a specific job", "Check ATS-friendliness"])
        self.assertFalse(q0["is_multi_select"])
        self.assertTrue(q0["allow_custom"])
        self.assertEqual(q0["placeholder"], "Something else...")

    def test_allow_custom_false(self):
        result = ask_question(
            question="Choose your operating system:",
            options=["Windows", "macOS", "Linux"],
            allow_custom=False,
        )
        self.assertEqual(len(result["questions"]), 1)
        q0 = result["questions"][0]
        self.assertFalse(q0["allow_custom"])
        self.assertIsNone(q0["placeholder"])

    def test_empty_or_missing_options(self):
        result = ask_question(
            question="Please enter your target job title:",
            options=None,
            allow_custom=True,
            placeholder="e.g. Senior DevOps Engineer"
        )
        q0 = result["questions"][0]
        self.assertEqual(q0["options"], [])
        self.assertTrue(q0["allow_custom"])
        self.assertEqual(q0["placeholder"], "e.g. Senior DevOps Engineer")

    def test_multi_question_payload_normalization(self):
        input_questions = [
            {
                "id": "k8s",
                "question": "Have you worked with Kubernetes?",
                "options": ["Yes, in production", "Yes, basic/learning", "No"],
                "is_multi_select": False,
                "allow_custom": True,
            },
            {
                "id": "iac",
                "question": "Which Infrastructure as Code tools have you used?",
                "options": ["Terraform", "CloudFormation", "Ansible", "PowerShell/Bash"],
                "is_multi_select": True,
                "allow_custom": True,
            },
            {
                "id": "years_exp",
                "question": "How many years of DevOps experience do you have?",
                "options": [],
                "allow_custom": True,
                "placeholder": "e.g. 3 years"
            }
        ]
        result = ask_question(questions=input_questions, header="DevOps Profiling")
        self.assertEqual(result["status"], "asked")
        self.assertEqual(result["header"], "DevOps Profiling")
        self.assertEqual(len(result["questions"]), 3)

        self.assertEqual(result["questions"][0]["id"], "k8s")
        self.assertFalse(result["questions"][0]["is_multi_select"])
        self.assertEqual(result["questions"][0]["header"], "DevOps Profiling")

        self.assertEqual(result["questions"][1]["id"], "iac")
        self.assertTrue(result["questions"][1]["is_multi_select"])
        self.assertEqual(len(result["questions"][1]["options"]), 4)

        self.assertEqual(result["questions"][2]["id"], "years_exp")
        self.assertEqual(result["questions"][2]["options"], [])
        self.assertEqual(result["questions"][2]["placeholder"], "e.g. 3 years")

    def test_malformed_questions_resilience(self):
        # Passing None or non-dict items in questions list
        malformed = [None, 123, "What is your target role?", {"question": "Are you open to relocation?", "options": ["Yes", "No"]}]
        result = ask_question(questions=malformed)
        self.assertEqual(len(result["questions"]), 2)
        self.assertEqual(result["questions"][0]["question"], "What is your target role?")
        self.assertEqual(result["questions"][1]["question"], "Are you open to relocation?")

    def test_completely_empty_call(self):
        result = ask_question()
        self.assertEqual(result["status"], "asked")
        self.assertEqual(len(result["questions"]), 1)
        self.assertTrue(result["questions"][0]["allow_custom"])

    def test_json_serializable(self):
        result = exported_ask_question(
            question="Select deployment target:",
            options=["AWS", "GCP", "Azure", "On-prem"],
            is_multi_select=True
        )
        dumped = json.dumps(result)
        loaded = json.loads(dumped)
        self.assertEqual(loaded["status"], "asked")
        self.assertEqual(len(loaded["questions"]), 1)


if __name__ == "__main__":
    unittest.main()
